/**
 * Browser push subscriptions: one row per device (browser profile), owned by the person
 * who turned it on. The endpoint is the push service's URL for that device; its keys
 * (p256dh, auth) are sealed. A device belongs to whoever subscribed it last, so a shared
 * computer follows the person signed in.
 */
import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '../crypto.ts';
import { sqlite } from '../store.ts';
import type { PushDevice } from '#lib/push.ts';
import { fromB64u, type Subscription } from './webpush.ts';

export class SubscriptionError extends Error {}

/** Push services of the browsers people use (host suffixes). Anything else needs OCM_PUSH_ENDPOINTS. */
export const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
export const MAX_DEVICES_PER_USER = 20;

/** Extra endpoint URL prefixes allowed (comma-separated), e.g. a self-hosted push service or a test mock. */
const extraPrefixes = () =>
	(process.env.OCM_PUSH_ENDPOINTS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

/**
 * Whether octo·modern will POST to this endpoint. Only https URLs of the known push
 * services (or OCM_PUSH_ENDPOINTS prefixes): the URL comes from the browser, and an
 * arbitrary one would let any signed-in user make the server send requests anywhere.
 */
export function endpointAllowed(endpoint: string): boolean {
	if (extraPrefixes().some((p) => endpoint.startsWith(p))) return true;
	let u: URL;
	try {
		u = new URL(endpoint);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
	const host = u.hostname.toLowerCase();
	return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** A subscription from the browser (`PushSubscription.toJSON()`), validated. */
export function parseSubscription(raw: unknown): Subscription {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const keys = (o.keys && typeof o.keys === 'object' ? o.keys : {}) as Record<string, unknown>;
	const endpoint = typeof o.endpoint === 'string' ? o.endpoint.trim() : '';
	if (!endpoint || endpoint.length > 1000) throw new SubscriptionError('The browser sent no push endpoint');
	if (!endpointAllowed(endpoint)) throw new SubscriptionError('That push service isn’t one octo·modern sends to (see OCM_PUSH_ENDPOINTS)');
	const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
	const auth = typeof keys.auth === 'string' ? keys.auth : '';
	if (!/^[-_A-Za-z0-9+/=]{80,100}$/.test(p256dh) || fromB64u(p256dh).length !== 65) throw new SubscriptionError('The subscription’s p256dh key is malformed');
	if (!/^[-_A-Za-z0-9+/=]{16,64}$/.test(auth) || fromB64u(auth).length < 16) throw new SubscriptionError('The subscription’s auth secret is malformed');
	return { endpoint, keys: { p256dh, auth } };
}

export interface StoredSubscription {
	id: string;
	userId: string;
	endpoint: string;
	keys: Subscription['keys'];
	vapidKey: string;
	label: string;
	createdAt: string;
	lastSentAt: string | null;
	lastError: string | null;
}

type Row = Record<string, unknown>;

function toStored(r: Row): StoredSubscription | null {
	try {
		return {
			id: r.id as string,
			userId: r.user_id as string,
			endpoint: r.endpoint as string,
			keys: JSON.parse(decrypt(r.secret as string, `push:${r.id}`)),
			vapidKey: r.vapid_key as string,
			label: r.label as string,
			createdAt: r.created_at as string,
			lastSentAt: (r.last_sent_at as string) ?? null,
			lastError: (r.last_error as string) ?? null
		};
	} catch {
		// Sealed with another master key: useless, forget it.
		sqlite().prepare('DELETE FROM push_subscriptions WHERE id = ?').run(r.id as string);
		return null;
	}
}

export const toDevice = (s: StoredSubscription): PushDevice => ({ id: s.id, label: s.label, endpoint: s.endpoint, createdAt: s.createdAt, lastSentAt: s.lastSentAt, lastError: s.lastError });

/** Adds (or takes over, or refreshes) the subscription of a device. */
export function saveSubscription(userId: string, sub: Subscription, o: { label: string; vapidKey: string }): StoredSubscription {
	const db = sqlite();
	const existing = db.prepare('SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint) as Row | undefined;
	if (!existing) {
		const n = (db.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number }).n;
		if (n >= MAX_DEVICES_PER_USER) throw new SubscriptionError(`At most ${MAX_DEVICES_PER_USER} devices per person; remove one first`);
	}
	const id = (existing?.id as string) ?? randomUUID();
	const label = o.label.trim().slice(0, 80) || 'Browser';
	const secret = encrypt(JSON.stringify(sub.keys), `push:${id}`);
	if (existing)
		db.prepare('UPDATE push_subscriptions SET user_id = ?, secret = ?, vapid_key = ?, label = ?, last_error = NULL WHERE id = ?').run(userId, secret, o.vapidKey, label, id);
	else
		db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, secret, vapid_key, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
			id,
			userId,
			sub.endpoint,
			secret,
			o.vapidKey,
			label,
			new Date().toISOString()
		);
	return getSubscription(id)!;
}

export function getSubscription(id: string): StoredSubscription | null {
	const r = sqlite().prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as Row | undefined;
	return r ? toStored(r) : null;
}

export function listSubscriptions(userId?: string): StoredSubscription[] {
	const rows = (userId
		? sqlite().prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(userId)
		: sqlite().prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all()) as Row[];
	return rows.map(toStored).filter((s): s is StoredSubscription => !!s);
}

/** Removes a device; only its owner's (`userId`) unless `userId` is null. */
export function deleteSubscription(id: string, userId: string | null): boolean {
	const q = userId == null ? sqlite().prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id) : sqlite().prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId);
	return Number(q.changes) > 0;
}

export function recordSend(id: string, error: string | null) {
	if (error) sqlite().prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').run(error.slice(0, 300), id);
	else sqlite().prepare('UPDATE push_subscriptions SET last_error = NULL, last_sent_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

/** Devices and distinct people, for admins. */
export function subscriptionCounts(): { devices: number; users: number } {
	const r = sqlite().prepare('SELECT count(*) AS devices, count(DISTINCT user_id) AS users FROM push_subscriptions').get() as { devices: number; users: number };
	return { devices: Number(r.devices), users: Number(r.users) };
}
