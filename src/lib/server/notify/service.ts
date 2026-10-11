/**
 * `notify(event)`: renders an event once, routes it through the rules, applies quiet
 * hours, de-dupe and rate limits per channel, attaches a webcam snapshot where a
 * channel can show one, delivers, and logs every outcome. Never throws.
 */
import jpeg from 'jpeg-js';
import { CHANNEL_TYPE_MAP, isCritical, type DeliveryStatus } from '#lib/notify.ts';
import { getPrinter } from '../store.ts';
import { getThumbnail } from '../history/store.ts';
import { ADAPTERS } from './channels/index.ts';
import { logDelivery } from './log.ts';
import { shareImage } from './media.ts';
import { render, testMessage } from './render.ts';
import { inQuietHours, Limiter, routeEvent } from './routing.ts';
import { load, parseChannel, publicUrlOf, recordResult, secretsOf, SettingsError, type StoredChannel } from './settings.ts';
import { webcamSnapshot } from './snapshot.ts';
import type { Image, Message, NotifyEvent } from './types.ts';

export interface Outcome {
	channelId: string;
	channelName: string;
	status: DeliveryStatus;
	error: string | null;
}

const KEY = Symbol.for('octo-modern.notify-limiter');
type G = typeof globalThis & { [KEY]?: Limiter };
/** Process-wide (survives dev-server reloads). */
export const limiter: Limiter = ((globalThis as G)[KEY] ??= new Limiter());

/** Overridable for tests: where snapshots come from. */
export const deps = {
	snapshot: async (printerId: string): Promise<Image | null> => {
		const p = getPrinter(printerId);
		return p ? webcamSnapshot(p) : null;
	},
	now: () => new Date()
};

/** The part of an event that makes it "the same" for de-dupe. */
export function dedupeKey(ev: NotifyEvent): string {
	const subject = ev.dedupeKey ?? (ev.print?.id != null ? `print:${ev.print.id}` : ev.print?.file ? `file:${ev.print.file}:${ev.print.startedAt ?? ''}` : '');
	return `${ev.kind}|${ev.printerId ?? ''}|${subject}`;
}

async function deliverTo(c: StoredChannel, m: Message): Promise<{ error: string | null; ms: number }> {
	const t0 = Date.now();
	try {
		const adapter = ADAPTERS[c.type];
		const info = CHANNEL_TYPE_MAP[c.type];
		// Channels that only take links get no bytes (and vice versa nothing is lost).
		const msg = info.images === 'none' ? { ...m, image: null, imageUrl: null } : m;
		await adapter.send({ config: c.config, secrets: secretsOf(c), message: msg });
		return { error: null, ms: Date.now() - t0 };
	} catch (err) {
		return { error: (err as Error).message || String(err), ms: Date.now() - t0 };
	}
}

export async function notify(ev: NotifyEvent): Promise<Outcome[]> {
	try {
		return await notifyInner(ev);
	} catch (err) {
		console.error('[octo-modern] notify failed', err);
		return [];
	}
}

async function notifyInner(ev: NotifyEvent): Promise<Outcome[]> {
	const s = load();
	if (!s.channels.length) return [];
	const ids = routeEvent(s.rules, ev.kind, ev.printerId);
	const targets = ids.map((id) => s.channels.find((c) => c.id === id)).filter((c): c is StoredChannel => !!c && c.enabled);
	if (!targets.length) return [];
	const publicUrl = publicUrlOf(s);
	const printerName = ev.printerName ?? (ev.printerId ? (getPrinter(ev.printerId)?.name ?? null) : null);
	const now = deps.now();
	const message = render(ev, { publicUrl, printerName, at: now.toISOString() });
	const critical = isCritical(message.severity);
	const key = dedupeKey(ev);
	const outcomes: Outcome[] = [];
	const go: StoredChannel[] = [];
	for (const c of targets) {
		let status: DeliveryStatus | null = null;
		if (inQuietHours(c.quiet, now) && !(critical && c.quiet.allowCritical)) status = 'quiet';
		else {
			const v = limiter.check(c.id, key, { dedupeMs: s.dedupeMinutes * 60_000, max: s.ratePer10Min }, now.getTime());
			if (v !== 'ok') status = v;
		}
		if (status) {
			outcomes.push({ channelId: c.id, channelName: c.name, status, error: null });
			logDelivery({ channelId: c.id, channelName: c.name, channelType: c.type, kind: ev.kind, printerName, title: message.title, status, error: null, ms: null, image: false });
		} else go.push(c);
	}
	if (!go.length) return outcomes;

	// One snapshot for every channel that can use it.
	const canLink = s.mediaLinks && !!publicUrl;
	const wantsImage = go.some((c) => CHANNEL_TYPE_MAP[c.type].images === 'attach' || (CHANNEL_TYPE_MAP[c.type].images === 'link' && canLink));
	if (wantsImage && ev.snapshot !== false) {
		if (ev.snapshot && typeof ev.snapshot === 'object') message.image = ev.snapshot;
		else if (ev.printerId) message.image = await deps.snapshot(ev.printerId).catch(() => null);
		// No camera: the picture the print history kept (e.g. the slicer's thumbnail).
		if (!message.image && ev.print?.id != null && ev.snapshot !== true) message.image = getThumbnail(ev.print.id) ?? null;
	}
	if (message.image && canLink) {
		try {
			message.imageUrl = shareImage(message.image, publicUrl!);
		} catch (err) {
			console.warn('[octo-modern] could not share the snapshot by link', err);
		}
	}

	const results = await Promise.all(go.map(async (c) => ({ c, ...(await deliverTo(c, message)) })));
	for (const { c, error, ms } of results) {
		const status: DeliveryStatus = error ? 'failed' : 'sent';
		if (error) console.warn(`[octo-modern] notification via ${c.name} (${c.type}) failed: ${error}`);
		recordResult(c.id, error);
		const image = !!(CHANNEL_TYPE_MAP[c.type].images === 'link' ? message.imageUrl : message.image);
		logDelivery({ channelId: c.id, channelName: c.name, channelType: c.type, kind: ev.kind, printerName, title: message.title, status, error, ms, image });
		outcomes.push({ channelId: c.id, channelName: c.name, status, error });
	}
	return outcomes;
}

let testImageCache: Image | null = null;

/** A small violet gradient JPEG, so "Send test" exercises attachments too. */
export function testImage(): Image {
	if (testImageCache) return testImageCache;
	const width = 320;
	const height = 180;
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const t = (x / width + y / height) / 2;
			data[i] = Math.round(167 - 58 * t);
			data[i + 1] = Math.round(139 - 99 * t);
			data[i + 2] = Math.round(250 - 33 * t);
			data[i + 3] = 255;
		}
	testImageCache = { data: new Uint8Array(jpeg.encode({ width, height, data }, 80).data), type: 'image/jpeg' };
	return testImageCache;
}

/**
 * Sends a test through a stored channel, or through a draft from the editor (with the
 * stored secrets of `id` filling in what the draft leaves empty). Throws with the
 * service's own answer.
 */
export async function testChannel(id: string | null, draft?: unknown): Promise<{ ms: number; image: boolean }> {
	const s = load();
	const stored = id ? s.channels.find((c) => c.id === id) : undefined;
	if (id && !stored) throw new SettingsError('No such channel (save it first)');
	let channel: StoredChannel;
	let secrets: Record<string, string>;
	if (draft !== undefined) {
		const parsed = parseChannel(draft, stored);
		channel = parsed.channel;
		secrets = parsed.secrets;
	} else {
		channel = stored!;
		secrets = secretsOf(stored!);
	}
	const publicUrl = publicUrlOf(s);
	const m = testMessage(publicUrl, channel.name);
	const kind = CHANNEL_TYPE_MAP[channel.type].images;
	m.image = testImage();
	if (kind === 'link' && s.mediaLinks && publicUrl) m.imageUrl = shareImage(m.image, publicUrl);
	const t0 = Date.now();
	let error: string | null = null;
	try {
		await ADAPTERS[channel.type].send({ config: channel.config, secrets, message: m });
	} catch (err) {
		error = (err as Error).message || String(err);
	}
	const ms = Date.now() - t0;
	if (stored) recordResult(stored.id, error);
	logDelivery({ channelId: channel.id, channelName: channel.name, channelType: channel.type, kind: 'test', printerName: null, title: m.title, status: error ? 'failed' : 'sent', error, ms, image: kind === 'attach' || !!m.imageUrl });
	if (error) throw new Error(error);
	return { ms, image: kind === 'attach' || !!m.imageUrl };
}
