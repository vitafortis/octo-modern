/**
 * OctoPrint timelapses: the listing and config (/api/timelapse), and the header
 * handling for relaying the videos with HTTP Range support, so a browser's <video>
 * can seek without downloading the whole file first. Pure, except `fetchTimelapseFile`.
 */
import { httpFetch } from './transport.ts';
import { toOctoPrintError } from './errors.ts';
import type { OctoPrintClient } from './client.ts';
import type { TimelapseConfig, TimelapseFile, TimelapseListing, TimelapseType, UnrenderedTimelapse } from '#lib/history.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Containers browsers play in a <video> element. OctoPrint renders mp4 by default (older versions: mpg). */
export const PLAYABLE = /\.(mp4|m4v|webm)$/i;

/** A file name in OctoPrint's timelapse folder: no separators, traversal or control characters. */
export function validTimelapseName(name: unknown): name is string {
	return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[/\\\x00-\x1f]/.test(name) && name !== '.' && name !== '..' && !name.startsWith('.');
}

/** OctoPrint's "2026-10-10 23:19" (local to OctoPrint) as epoch ms; `timestamp` (epoch s) wins when present. */
function fileDate(f: Obj): number | null {
	const ts = num(f.timestamp);
	if (ts != null) return Math.round(ts * 1000);
	const d = str(f.date);
	if (!d) return null;
	const t = Date.parse(d.replace(' ', 'T'));
	return Number.isNaN(t) ? null : t;
}

export function parseTimelapseConfig(raw: unknown): TimelapseConfig {
	const c = isObj(raw) ? raw : {};
	const type: TimelapseType = c.type === 'zchange' || c.type === 'timed' ? c.type : 'off';
	return { type, fps: num(c.fps), interval: num(c.interval), postRoll: num(c.postRoll), retractionZHop: num(c.retractionZHop), minDelay: num(c.minDelay) };
}

export function parseTimelapseListing(raw: unknown): TimelapseListing {
	const r = isObj(raw) ? raw : {};
	const files: TimelapseFile[] = (Array.isArray(r.files) ? r.files : [])
		.filter(isObj)
		.filter((f) => validTimelapseName(f.name))
		.map((f) => {
			const thumbUrl = str(f.thumbnail);
			const thumb = thumbUrl ? decodeURIComponent(thumbUrl.split('?')[0].split('/').pop() ?? '') : null;
			return {
				name: f.name as string,
				bytes: num(f.bytes),
				date: fileDate(f),
				thumbnail: thumb && validTimelapseName(thumb) ? thumb : null,
				playable: PLAYABLE.test(f.name as string)
			};
		})
		.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
	const unrendered: UnrenderedTimelapse[] = (Array.isArray(r.unrendered) ? r.unrendered : [])
		.filter(isObj)
		.filter((f) => validTimelapseName(f.name))
		.map((f) => ({
			name: f.name as string,
			bytes: num(f.bytes),
			date: fileDate(f),
			count: num(f.count),
			recording: f.recording === true,
			rendering: f.rendering === true,
			processing: f.processing === true
		}))
		.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
	return { enabled: r.enabled !== false, config: parseTimelapseConfig(r.config), files, unrendered };
}

/** Validates a config change; returns OctoPrint's body for POST /api/timelapse. Throws with a message for the user. */
export function timelapseConfigBody(b: Record<string, unknown>): Record<string, unknown> {
	const type = b.type;
	if (type !== 'off' && type !== 'zchange' && type !== 'timed') throw new Error('"type" must be off, zchange or timed');
	const out: Record<string, unknown> = { type, save: true };
	const range = (key: string, min: number, max: number, int = true) => {
		if (b[key] === undefined || b[key] === null || b[key] === '') return;
		const n = Number(b[key]);
		if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new Error(`${key} must be ${int ? 'a whole number ' : ''}between ${min} and ${max}`);
		out[key] = n;
	};
	range('fps', 1, 120);
	range('postRoll', 0, 600);
	if (type === 'timed') range('interval', 1, 3600);
	if (type === 'zchange') {
		range('retractionZHop', 0, 10, false);
		range('minDelay', 0, 600, false);
	}
	return out;
}

// --- relaying a video with Range support -------------------------------------------

/**
 * Request headers worth forwarding to OctoPrint: a single byte range (what <video>
 * asks for), and the validators that make a range or a cache check conditional.
 * Multi-range and malformed ranges are dropped: the full file is a valid answer.
 */
export function forwardHeaders(h: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	const range = h.get('range')?.trim();
	if (range && /^bytes=(\d+-\d*|-\d+)$/.test(range)) {
		out.range = range;
		const ifRange = h.get('if-range');
		if (ifRange) out['if-range'] = ifRange;
	}
	for (const k of ['if-none-match', 'if-modified-since']) {
		const v = h.get(k);
		if (v) out[k] = v;
	}
	return out;
}

const CONTENT_TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mpg: 'video/mpeg', mpeg: 'video/mpeg', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

export function contentTypeFor(name: string, upstream?: string | null): string {
	const ext = name.toLowerCase().split('.').pop() ?? '';
	const known = CONTENT_TYPES[ext];
	// OctoPrint sometimes says application/octet-stream; a known extension is more useful to a browser.
	if (known && (!upstream || /octet-stream/i.test(upstream))) return known;
	return upstream || known || 'application/octet-stream';
}

/** RFC 6266 attachment/inline header, with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(name: string, download: boolean): string {
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Statuses passed through to the browser as they are. */
export const PASS_STATUSES = new Set([200, 206, 304, 416]);

/**
 * Response headers for the browser: length, range, validators and type from
 * OctoPrint's answer (it serves timelapses with Range support), our own disposition
 * and caching. `accept-ranges: bytes` is announced only when OctoPrint does.
 */
export function responseHeaders(upstream: Headers, name: string, download: boolean): Record<string, string> {
	const out: Record<string, string> = {
		'content-type': contentTypeFor(name, upstream.get('content-type')),
		'content-disposition': contentDisposition(name, download),
		'cache-control': 'private, max-age=0, must-revalidate',
		'x-content-type-options': 'nosniff'
	};
	for (const k of ['content-length', 'content-range', 'etag', 'last-modified', 'accept-ranges']) {
		const v = upstream.get(k);
		if (v) out[k] = v;
	}
	return out;
}

/**
 * Fetches a file from OctoPrint's timelapse folder (/downloads/timelapse/<name>) as a
 * stream: the timeout applies to getting the headers only, and the browser leaving
 * (`signal`) aborts it.
 */
export async function fetchTimelapseFile(client: OctoPrintClient, name: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), client.timeoutMs);
	const onAbort = () => abort.abort();
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		return await httpFetch(
			client.url(`/downloads/timelapse/${encodeURIComponent(name)}`),
			{ headers: { 'X-Api-Key': client.target.apiKey, ...headers }, signal: abort.signal },
			client.target.verifyTls
		);
	} catch (err) {
		signal.removeEventListener('abort', onAbort);
		throw toOctoPrintError(abort.signal.reason ?? err, client.host);
	} finally {
		clearTimeout(timer);
	}
}
