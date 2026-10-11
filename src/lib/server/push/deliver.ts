/**
 * Delivers a rendered notification to the subscribed devices of the people allowed to
 * get it: the channel's audience (everyone / operators and admins / admins) who can see
 * the printer (per-printer access). Devices the push service reports gone (404/410) and
 * devices of removed people are forgotten.
 */
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { canSee } from '../permissions.ts';
import { getUser } from '../store.ts';
import { deleteSubscription, listSubscriptions, recordSend, type StoredSubscription } from './subscriptions.ts';
import { vapidKeys, vapidSubject } from './vapid.ts';
import { buildRequest, PushError, sendPush, type Urgency } from './webpush.ts';
import type { Message } from '../notify/types.ts';
import type { PushPayload } from '#lib/push.ts';
import type { User } from '#lib/types.ts';

export type Audience = 'all' | 'control' | 'admin';
export const isAudience = (v: unknown): v is Audience => v === 'all' || v === 'control' || v === 'admin';

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The path to open on click: the message's link (same origin), else the printer, else home. */
export function clickPath(m: Pick<Message, 'url' | 'printer' | 'kind'>): string {
	if (m.url) {
		try {
			const u = new URL(m.url);
			return `${u.pathname}${u.search}${u.hash}` || '/';
		} catch {}
	}
	if (m.printer) {
		const ended = m.kind === 'print.finished' || m.kind === 'print.failed' || m.kind === 'print.cancelled';
		return `/p/${encodeURIComponent(m.printer.id)}${ended ? '?tab=history' : ''}`;
	}
	return '/';
}

/** One notification per printer and topic: a print's messages replace each other, and so do a printer's state changes. */
export function tagOf(m: Pick<Message, 'kind' | 'printer'>): string {
	const topic = m.kind.startsWith('print.') ? 'print' : m.kind.startsWith('printer.') ? 'printer' : m.kind;
	return `ocm:${m.printer?.id ?? '-'}:${topic}`;
}

/** What the service worker gets (kept well under the 4 KB push limit). */
export function buildPayload(m: Message): PushPayload {
	const p: PushPayload = {
		title: cut(m.title, 120),
		body: cut(m.text, 600),
		url: cut(clickPath(m), 500),
		tag: tagOf(m),
		kind: m.kind,
		severity: m.severity,
		printerId: m.printer?.id ?? null,
		at: m.at
	};
	if (m.imageUrl && m.imageUrl.length < 600) p.image = m.imageUrl;
	return p;
}

/** Push service hints: errors are urgent, progress isn't (and replaces an undelivered one). */
export function deliveryOptions(m: Pick<Message, 'kind' | 'severity' | 'printer'>): { ttlS: number; urgency: Urgency; topic?: string } {
	if (m.kind === 'print.progress') {
		const topic = createHash('sha256').update(`progress:${m.printer?.id ?? ''}`).digest('base64url').slice(0, 32);
		return { ttlS: 3600, urgency: 'low', topic };
	}
	return { ttlS: 24 * 3600, urgency: m.severity === 'error' ? 'high' : 'normal' };
}

const OPEN_USER = { id: 'open', role: 'admin', printerAccess: 'all' } as User;

/** The person behind a subscription, or null when it should be forgotten. */
function ownerOf(s: StoredSubscription): User | null {
	if (s.userId === 'open') return config.authDisabled ? OPEN_USER : null;
	return getUser(s.userId) ?? null;
}

export function audienceAllows(audience: Audience, user: Pick<User, 'role'>): boolean {
	if (audience === 'admin') return user.role === 'admin';
	if (audience === 'control') return user.role === 'admin' || user.role === 'operator';
	return true;
}

export interface Recipients {
	targets: StoredSubscription[];
	/** Subscriptions dropped on the way (owner gone, made for an old VAPID key). */
	removed: number;
	/** Subscriptions there are at all (before the audience and access filters). */
	total: number;
}

/** Who gets `m`: subscriptions of enabled people in the audience who can see the printer. */
export function recipients(m: Pick<Message, 'printer'>, audience: Audience, opts: { only?: string[]; publicKey?: string } = {}): Recipients {
	const publicKey = opts.publicKey ?? vapidKeys().publicKey;
	let all = listSubscriptions();
	if (opts.only) all = all.filter((s) => opts.only!.includes(s.id));
	const targets: StoredSubscription[] = [];
	let removed = 0;
	for (const s of all) {
		const user = ownerOf(s);
		// The person was removed, or the key changed (the browser re-subscribes on its next visit).
		if (!user || s.vapidKey !== publicKey) {
			deleteSubscription(s.id, null);
			removed++;
			continue;
		}
		if (user.disabled) continue;
		if (!audienceAllows(audience, user)) continue;
		if (m.printer && !canSee(user, { id: m.printer.id })) continue;
		targets.push(s);
	}
	return { targets, removed, total: all.length };
}

export interface DeliveryReport {
	sent: number;
	failed: number;
	/** Gone at the push service (404/410), now forgotten. */
	gone: number;
	targets: number;
	total: number;
	errors: string[];
}

/** Sends `m` to `targets`, ten at a time. Never throws. */
export async function sendTo(targets: StoredSubscription[], m: Message, o: { publicUrl: string | null }): Promise<Omit<DeliveryReport, 'total'>> {
	const keys = vapidKeys();
	const subject = vapidSubject(o.publicUrl);
	const payload = JSON.stringify(buildPayload(m));
	const opts = deliveryOptions(m);
	const report = { sent: 0, failed: 0, gone: 0, targets: targets.length, errors: [] as string[] };
	for (let i = 0; i < targets.length; i += 10) {
		await Promise.all(
			targets.slice(i, i + 10).map(async (s) => {
				try {
					await sendPush(buildRequest(s, payload, { vapid: keys, subject, ...opts }));
					recordSend(s.id, null);
					report.sent++;
				} catch (err) {
					if (err instanceof PushError && err.gone) {
						deleteSubscription(s.id, null);
						report.gone++;
						return;
					}
					const msg = (err as Error).message || String(err);
					recordSend(s.id, msg);
					report.failed++;
					if (report.errors.length < 5) report.errors.push(`${s.label}: ${msg}`);
				}
			})
		);
	}
	return report;
}

/** Routes `m` to the audience's devices and sends it. */
export async function deliver(m: Message, audience: Audience, o: { publicUrl: string | null; only?: string[] }): Promise<DeliveryReport> {
	const r = recipients(m, audience, { only: o.only });
	const sent = await sendTo(r.targets, m, o);
	return { ...sent, total: r.total - r.removed };
}
