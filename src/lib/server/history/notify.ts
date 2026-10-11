/**
 * Notifications when a print ends: ntfy, Discord or a generic JSON webhook, per
 * outcome. The channel formats follow pg·modern's alert channels (alerts/notify.ts
 * there). `buildRequest` is pure (tested); `deliver` does the HTTP call. Secrets
 * (webhook URLs, tokens) are sealed in the store and never sent back to the browser.
 */
import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '../crypto.ts';
import { getKv, setKv } from '../store.ts';
import { formatDuration } from '#lib/printer.ts';
import type { PrintRecord } from '#lib/history.ts';

export type ChannelKind = 'ntfy' | 'discord' | 'webhook';
export const CHANNEL_KINDS: ChannelKind[] = ['ntfy', 'discord', 'webhook'];
export type EndResult = 'success' | 'failed' | 'cancelled';
/** What a channel can subscribe to: print outcomes, and failure detection (detect/notify.ts). */
export type NotifyOn = EndResult | 'failure.suspected';

export interface PrintNotification {
	event: EndResult | 'test' | 'failure.suspected';
	title: string;
	message: string;
	printer: { id: string; name: string } | null;
	print: Pick<PrintRecord, 'id' | 'file' | 'path' | 'startedAt' | 'endedAt' | 'durationS' | 'filamentMm' | 'completion' | 'startedBy' | 'reason'> | null;
	at: string;
	/** Link to the printer in octo·modern, when its address is known. */
	url: string | null;
}

export interface OutgoingRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

const LABEL: Record<PrintNotification['event'], string> = { success: 'Print finished', failed: 'Print failed', cancelled: 'Print cancelled', test: 'Test', 'failure.suspected': 'Failure suspected' };
export const DISCORD_COLORS: Record<PrintNotification['event'], number> = { success: 0x22c55e, failed: 0xef4444, cancelled: 0xf59e0b, test: 0x8b5cf6, 'failure.suspected': 0xf97316 };
const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** The notification for a finished print. */
export function printNotification(r: PrintRecord, publicUrl: string | null, at = new Date().toISOString()): PrintNotification {
	const event = (r.result === 'success' || r.result === 'failed' || r.result === 'cancelled' ? r.result : 'failed') as EndResult;
	const parts = [
		r.durationS != null ? `after ${formatDuration(r.durationS)}` : null,
		event !== 'success' && r.completion != null ? `at ${Math.round(r.completion)}%` : null,
		r.filamentMm ? `${(r.filamentMm / 1000).toFixed(2)} m filament` : null,
		r.reason && event === 'failed' ? `reason: ${r.reason}` : null,
		r.startedBy ? `started by ${r.startedBy}` : null
	].filter(Boolean);
	return {
		event,
		title: `${LABEL[event]}: ${r.file}`,
		message: `${r.printerName}: ${r.file} ${event === 'success' ? 'finished' : event}${parts.length ? ` ${parts.join(', ')}` : ''}.`,
		printer: { id: r.printerId, name: r.printerName },
		print: { id: r.id, file: r.file, path: r.path, startedAt: r.startedAt, endedAt: r.endedAt, durationS: r.durationS, filamentMm: r.filamentMm, completion: r.completion, startedBy: r.startedBy, reason: r.reason },
		at,
		url: publicUrl ? `${trimSlash(publicUrl)}/p/${encodeURIComponent(r.printerId)}?tab=history` : null
	};
}

/** The JSON body POSTed to generic webhooks (documented in the README; `version` changes only if the shape does). */
export function webhookPayload(n: PrintNotification) {
	return { source: 'octo-modern', version: 1, event: n.event, title: n.title, message: n.message, printer: n.printer, print: n.print, at: n.at, url: n.url };
}

export function buildRequest(kind: ChannelKind, config: Record<string, string>, secrets: Record<string, string>, n: PrintNotification): OutgoingRequest {
	const json = { 'content-type': 'application/json' };
	switch (kind) {
		case 'ntfy': {
			// JSON publishing: POST to the server root with the topic in the body.
			const headers: Record<string, string> = { ...json };
			if (secrets.token) headers.authorization = `Bearer ${secrets.token}`;
			return {
				url: trimSlash(config.server || 'https://ntfy.sh'),
				headers,
				body: JSON.stringify({
					topic: config.topic,
					title: n.title,
					message: n.message,
					priority: n.event === 'failed' ? 4 : 3,
					tags: [n.event === 'success' ? 'white_check_mark' : n.event === 'failed' ? 'x' : n.event === 'cancelled' ? 'stop_sign' : 'bell', 'octo-modern'],
					...(n.url ? { click: n.url } : {})
				})
			};
		}
		case 'discord':
			return {
				url: secrets.url,
				headers: json,
				body: JSON.stringify({
					username: 'octo·modern',
					embeds: [
						{
							title: n.title.slice(0, 256),
							description: n.message.slice(0, 4000),
							color: DISCORD_COLORS[n.event],
							timestamp: n.at,
							...(n.url ? { url: n.url } : {}),
							...(n.printer ? { footer: { text: n.printer.name } } : {})
						}
					]
				})
			};
		case 'webhook': {
			const headers: Record<string, string> = { ...json, 'user-agent': 'octo-modern' };
			if (secrets.authorization) headers.authorization = secrets.authorization;
			return { url: secrets.url, headers, body: JSON.stringify(webhookPayload(n)) };
		}
	}
}

/** Sends a notification; throws with the service's answer on failure. */
export async function deliver(kind: ChannelKind, config: Record<string, string>, secrets: Record<string, string>, n: PrintNotification): Promise<void> {
	const req = buildRequest(kind, config, secrets, n);
	if (!/^https?:\/\//i.test(req.url ?? '')) throw new Error('The channel has no valid http(s) URL');
	let res: Response;
	try {
		res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000), redirect: 'error' });
	} catch (err) {
		const cause = (err as { cause?: { code?: string; message?: string } }).cause;
		throw new Error(cause?.code ?? cause?.message ?? (err as Error).message);
	}
	if (!res.ok) {
		const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
		throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
	}
}

/** A safe-to-show hint for a secret: the host of a URL, or that a token is set. */
export function secretHint(value: string): string {
	try {
		return `${new URL(value).host}/…`;
	} catch {
		return '••••••';
	}
}

// --- stored channels --------------------------------------------------------------------

const KEY = 'history:notifications';
/** Secret fields per kind (sealed); the rest is plain config. */
const SECRET_FIELDS: Record<ChannelKind, string[]> = { ntfy: ['token'], discord: ['url'], webhook: ['url', 'authorization'] };
const CONFIG_FIELDS: Record<ChannelKind, string[]> = { ntfy: ['server', 'topic'], discord: [], webhook: [] };

interface StoredChannel {
	id: string;
	kind: ChannelKind;
	name: string;
	enabled: boolean;
	on: NotifyOn[];
	config: Record<string, string>;
	sealed: string | null;
	lastError: string | null;
	lastSentAt: string | null;
}

interface Stored {
	channels: StoredChannel[];
	/** octo·modern's address as the admin saw it, for links in notifications. */
	publicUrl: string | null;
}

/** A channel as the browser sees it: secrets replaced by hints. */
export interface ChannelInfo {
	id: string;
	kind: ChannelKind;
	name: string;
	enabled: boolean;
	on: NotifyOn[];
	config: Record<string, string>;
	secrets: Record<string, string>;
	lastError: string | null;
	lastSentAt: string | null;
}

const load = (): Stored => getKv<Stored>(KEY, { channels: [], publicUrl: null });
const secretsOf = (c: StoredChannel): Record<string, string> => (c.sealed ? JSON.parse(decrypt(c.sealed, `notify:${c.id}`)) : {});

export function listChannels(): ChannelInfo[] {
	return load().channels.map((c) => {
		const s = secretsOf(c);
		return { id: c.id, kind: c.kind, name: c.name, enabled: c.enabled, on: c.on, config: c.config, secrets: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, secretHint(v)])), lastError: c.lastError, lastSentAt: c.lastSentAt };
	});
}

const RESULTS: NotifyOn[] = ['success', 'failed', 'cancelled', 'failure.suspected'];

/**
 * Replaces the channel list. A secret field left out (or empty) keeps the stored value
 * of the channel with that id; throws with a message for the user on invalid input.
 */
export function saveChannels(raw: unknown, publicUrl: string | null): ChannelInfo[] {
	if (!Array.isArray(raw) || raw.length > 20) throw new Error('"channels" must be a list (at most 20)');
	const prev = new Map(load().channels.map((c) => [c.id, c]));
	const channels: StoredChannel[] = raw.map((r, i) => {
		const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
		const kind = o.kind as ChannelKind;
		if (!CHANNEL_KINDS.includes(kind)) throw new Error(`Channel ${i + 1}: unknown kind`);
		const id = typeof o.id === 'string' && prev.has(o.id) ? o.id : randomUUID();
		const old = prev.get(id);
		const oldSecrets = old && old.kind === kind ? secretsOf(old) : {};
		const inConfig = (o.config && typeof o.config === 'object' ? o.config : {}) as Record<string, unknown>;
		const inSecrets = (o.secrets && typeof o.secrets === 'object' ? o.secrets : {}) as Record<string, unknown>;
		const config: Record<string, string> = {};
		for (const f of CONFIG_FIELDS[kind]) if (typeof inConfig[f] === 'string' && inConfig[f]) config[f] = (inConfig[f] as string).trim().slice(0, 500);
		const secrets: Record<string, string> = {};
		for (const f of SECRET_FIELDS[kind]) {
			const v = typeof inSecrets[f] === 'string' ? (inSecrets[f] as string).trim() : '';
			if (v) secrets[f] = v.slice(0, 2000);
			else if (oldSecrets[f]) secrets[f] = oldSecrets[f];
		}
		const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : kind;
		if (kind === 'ntfy') {
			if (!config.topic) throw new Error(`${name}: an ntfy topic is required`);
			if (config.server && !/^https?:\/\//i.test(config.server)) throw new Error(`${name}: the ntfy server must be an http(s) URL`);
		} else if (!/^https?:\/\//i.test(secrets.url ?? '')) throw new Error(`${name}: a webhook URL (http or https) is required`);
		const on = Array.isArray(o.on) ? RESULTS.filter((x) => (o.on as unknown[]).includes(x)) : ['failed' as const];
		return {
			id,
			kind,
			name,
			enabled: o.enabled !== false,
			on,
			config,
			sealed: Object.keys(secrets).length ? encrypt(JSON.stringify(secrets), `notify:${id}`) : null,
			lastError: old?.lastError ?? null,
			lastSentAt: old?.lastSentAt ?? null
		};
	});
	setKv(KEY, { channels, publicUrl: publicUrl ?? load().publicUrl });
	return listChannels();
}

export function record(id: string, error: string | null) {
	const s = load();
	const c = s.channels.find((x) => x.id === id);
	if (!c) return;
	c.lastError = error;
	if (!error) c.lastSentAt = new Date().toISOString();
	setKv(KEY, s);
}

/** Sends a test message through one stored channel. */
export async function testChannel(id: string): Promise<void> {
	const c = load().channels.find((x) => x.id === id);
	if (!c) throw new Error('No such channel (save it first)');
	const n: PrintNotification = { event: 'test', title: 'Test from octo·modern', message: 'Print notifications reach this channel.', printer: null, print: null, at: new Date().toISOString(), url: load().publicUrl };
	try {
		await deliver(c.kind, c.config, secretsOf(c), n);
		record(id, null);
	} catch (err) {
		record(id, (err as Error).message);
		throw err;
	}
}

/** Notifies every enabled channel subscribed to this print's outcome. Never throws. */
export async function notifyPrintEnded(r: PrintRecord): Promise<void> {
	const s = load();
	const targets = s.channels.filter((c) => c.enabled && c.on.includes(r.result as EndResult));
	if (!targets.length) return;
	const n = printNotification(r, s.publicUrl);
	await Promise.all(
		targets.map(async (c) => {
			try {
				await deliver(c.kind, c.config, secretsOf(c), n);
				record(c.id, null);
			} catch (err) {
				record(c.id, (err as Error).message);
				console.warn(`[octo-modern] notification via ${c.name} failed: ${(err as Error).message}`);
			}
		})
	);
}

/** Enabled channels subscribed to `on`, with their secrets (server-only; for detect/notify.ts). */
export function subscribedChannels(on: NotifyOn): { id: string; kind: ChannelKind; name: string; config: Record<string, string>; secrets: Record<string, string> }[] {
	return load()
		.channels.filter((c) => c.enabled && c.on.includes(on))
		.map((c) => ({ id: c.id, kind: c.kind, name: c.name, config: c.config, secrets: secretsOf(c) }));
}
