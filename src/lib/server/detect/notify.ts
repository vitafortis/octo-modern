/**
 * `failure.suspected` notifications, with the annotated frame attached, through the
 * channels in history/notify.ts that subscribe to it:
 *
 * - ntfy: the JPEG as an attachment (`PUT <server>/<topic>` with the image as the body;
 *   title, message, tags, priority, click and filename as query parameters, which
 *   ntfy accepts in place of headers and which keeps non-ASCII text intact).
 * - Discord: a multipart webhook call, the image as `files[0]` shown in the embed.
 * - Webhook: the usual JSON (version 1) plus `detection` and `image` (base64).
 *
 * `buildFailureRequest` is pure (tested); `notifyFailure` sends and never throws.
 */
import { DISCORD_COLORS, record, subscribedChannels, webhookPayload, type ChannelKind, type PrintNotification } from '../history/notify.ts';
import { shrinkJpeg } from '../history/jpeg.ts';
import type { DetectLevel, FailureAction } from '#lib/detect.ts';

export interface FailureInfo {
	level: Exclude<DetectLevel, 'ok'>;
	/** Normalized 0–1. */
	score: number;
	/** What octo·modern did about it. */
	action: FailureAction | 'paused' | 'pause-failed';
}

export interface FailureRequest {
	url: string;
	method: 'POST' | 'PUT';
	headers: Record<string, string>;
	body: string | Uint8Array | FormData;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');
const FILENAME = 'failure.jpg';

export function failureNotification(o: { printer: { id: string; name: string }; file: string | null; info: FailureInfo; publicUrl: string | null; at?: string }): PrintNotification {
	const pct = Math.round(o.info.score * 100);
	const what =
		o.info.action === 'paused'
			? 'octo·modern paused the print.'
			: o.info.action === 'pause-failed'
				? 'octo·modern tried to pause the print but OctoPrint refused.'
				: o.info.level === 'failure'
					? 'The print looks like it has failed.'
					: 'The print may be failing.';
	return {
		event: 'failure.suspected',
		title: `${o.info.level === 'failure' ? 'Print failure detected' : 'Failure suspected'}: ${o.printer.name}`,
		message: `${o.printer.name}${o.file ? ` (${o.file})` : ''}: failure score ${pct}%. ${what}`,
		printer: o.printer,
		print: null,
		at: o.at ?? new Date().toISOString(),
		url: o.publicUrl ? `${trimSlash(o.publicUrl)}/p/${encodeURIComponent(o.printer.id)}?tab=detection` : null
	};
}

export function buildFailureRequest(kind: ChannelKind, config: Record<string, string>, secrets: Record<string, string>, n: PrintNotification, info: FailureInfo, image: Uint8Array | null): FailureRequest {
	switch (kind) {
		case 'ntfy': {
			const q = new URLSearchParams({
				title: n.title,
				message: n.message,
				priority: info.level === 'failure' ? '5' : '4',
				tags: ['warning', 'octo-modern'].join(',')
			});
			if (n.url) q.set('click', n.url);
			const headers: Record<string, string> = {};
			if (secrets.token) headers.authorization = `Bearer ${secrets.token}`;
			if (image) {
				q.set('filename', FILENAME);
				headers['content-type'] = 'image/jpeg';
			}
			return { url: `${trimSlash(config.server || 'https://ntfy.sh')}/${encodeURIComponent(config.topic ?? '')}?${q}`, method: 'PUT', headers, body: image ?? '' };
		}
		case 'discord': {
			const embed = {
				title: n.title.slice(0, 256),
				description: n.message.slice(0, 4000),
				color: DISCORD_COLORS['failure.suspected'],
				timestamp: n.at,
				...(n.url ? { url: n.url } : {}),
				...(n.printer ? { footer: { text: n.printer.name } } : {}),
				...(image ? { image: { url: `attachment://${FILENAME}` } } : {})
			};
			const payload = JSON.stringify({ username: 'octo·modern', embeds: [embed] });
			if (!image) return { url: secrets.url, method: 'POST', headers: { 'content-type': 'application/json' }, body: payload };
			const form = new FormData();
			form.set('payload_json', payload);
			form.set('files[0]', new Blob([image as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), FILENAME);
			return { url: secrets.url, method: 'POST', headers: {}, body: form };
		}
		case 'webhook': {
			const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'octo-modern' };
			if (secrets.authorization) headers.authorization = secrets.authorization;
			const body = {
				...webhookPayload(n),
				detection: { level: info.level, score: Math.round(info.score * 1000) / 1000, action: info.action },
				image: image ? { contentType: 'image/jpeg', filename: FILENAME, base64: Buffer.from(image).toString('base64') } : null
			};
			return { url: secrets.url, method: 'POST', headers, body: JSON.stringify(body) };
		}
	}
}

/** Sends to every enabled channel subscribed to `failure.suspected`. Never throws; returns how many got it. */
export async function notifyFailure(n: PrintNotification, info: FailureInfo, frame: Uint8Array | null): Promise<number> {
	const targets = subscribedChannels('failure.suspected');
	if (!targets.length) return 0;
	// Attachments stay small: Discord and ntfy have limits, and phones on mobile data.
	const image = frame ? (shrinkJpeg(frame, 400 * 1024) ?? null) : null;
	let sent = 0;
	await Promise.all(
		targets.map(async (c) => {
			try {
				const req = buildFailureRequest(c.kind, c.config, c.secrets, n, info, image);
				if (!/^https?:\/\//i.test(req.url ?? '')) throw new Error('The channel has no valid http(s) URL');
				const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit, signal: AbortSignal.timeout(15_000), redirect: 'error' });
				if (!res.ok) {
					const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
					throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
				}
				record(c.id, null);
				sent++;
			} catch (err) {
				const cause = (err as { cause?: { code?: string } }).cause;
				const msg = cause?.code ?? (err as Error).message;
				record(c.id, msg);
				console.warn(`[octo-modern] failure notification via ${c.name} failed: ${msg}`);
			}
		})
	);
	return sent;
}
