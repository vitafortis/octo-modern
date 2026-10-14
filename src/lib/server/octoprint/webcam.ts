/**
 * Webcams of a printer: the admin's override URL, or the cameras the server reports:
 * Klipper's from Moonraker's `server.webcams.list` (see moonraker/parse.ts), OctoPrint's
 * from its settings (`webcam.webcams` on OctoPrint ≥1.9, one per webcam plugin camera;
 * the legacy `webcam.streamUrl` / `snapshotUrl` before that). Relative URLs such as
 * `/webcam/?action=stream` resolve against the OctoPrint base URL.
 *
 * MJPEG streams and snapshots are proxied through octo·modern, so the browser never
 * needs to reach the camera or OctoPrint. HLS and WebRTC streams can't be relayed as
 * a plain image; the UI offers a link to open them directly instead.
 */
import { backendFor } from '../backend/index.ts';
import { getApiKey } from '../store.ts';
import { httpFetch } from './transport.ts';
import { OctoPrintError, toOctoPrintError } from './errors.ts';
import type { Printer } from '#lib/types.ts';

export type StreamKind = 'mjpeg' | 'hls' | 'webrtc';

export interface Camera {
	/** Stable within a printer: OctoPrint's webcam name, `classic`, or `override`. */
	id: string;
	label: string;
	snapshotUrl: string | null;
	streamUrl: string | null;
	kind: StreamKind | null;
	flipH: boolean;
	flipV: boolean;
	rotate90: boolean;
	source: 'override' | 'octoprint';
}

/** What the browser gets: no URLs for proxied cameras (they may be LAN-only or carry credentials). */
export interface CameraInfo {
	id: string;
	label: string;
	snapshot: boolean;
	stream: StreamKind | null;
	/** MJPEG: watch through …/webcam/stream. */
	proxied: boolean;
	/** HLS/WebRTC: the URL to open directly (octo·modern can't relay it). */
	externalUrl: string | null;
	flipH: boolean;
	flipV: boolean;
	rotate90: boolean;
	source: Camera['source'];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function resolveUrl(raw: unknown, baseUrl: string): string | null {
	const s = str(raw);
	if (!s) return null;
	try {
		const u = new URL(s, `${baseUrl}/`);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
	} catch {
		return null;
	}
}

/** Guesses the stream type from its URL; MJPEG unless it clearly isn't. */
export function streamKind(url: string | null): StreamKind | null {
	if (!url) return null;
	if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
	if (/webrtc|whep|\/rtc(\/|\?|$)/i.test(url)) return 'webrtc';
	return 'mjpeg';
}

/** mjpg-streamer / ustreamer / camera-streamer convention: `?action=stream` ↔ `?action=snapshot`, `/stream` ↔ `/snapshot`. */
export function siblingUrl(url: string, want: 'snapshot' | 'stream'): string | null {
	const other = want === 'snapshot' ? 'stream' : 'snapshot';
	if (new RegExp(`action=${other}`, 'i').test(url)) return url.replace(new RegExp(`action=${other}`, 'i'), `action=${want}`);
	if (new RegExp(`/${other}(\\?|$)`, 'i').test(url)) return url.replace(new RegExp(`/${other}(\\?|$)`, 'i'), `/${want}$1`);
	return null;
}

function camera(id: string, label: string, stream: string | null, snapshot: string | null, o: Obj, source: Camera['source']): Camera | null {
	const kind = streamKind(stream);
	const snap = snapshot ?? (stream && kind === 'mjpeg' ? siblingUrl(stream, 'snapshot') : null);
	if (!stream && !snap) return null;
	return { id, label, streamUrl: stream, snapshotUrl: snap, kind, flipH: o.flipH === true, flipV: o.flipV === true, rotate90: o.rotate90 === true, source };
}

/** Interprets the override field: a stream or snapshot URL, absolute or relative to the OctoPrint host. */
export function camerasFromOverride(raw: string, baseUrl: string): Camera[] {
	const url = resolveUrl(raw, baseUrl);
	if (!url) return [];
	const isSnapshot = /action=snapshot|\/snapshot(\?|$)|\.(jpe?g|png|webp)(\?|$)/i.test(url);
	const c = isSnapshot ? camera('override', 'Webcam', siblingUrl(url, 'stream'), url, {}, 'override') : camera('override', 'Webcam', url, null, {}, 'override');
	return c ? [c] : [];
}

/** Cameras from OctoPrint's /api/settings. */
export function camerasFromSettings(settings: unknown, baseUrl: string): Camera[] {
	if (!isObj(settings) || !isObj(settings.webcam)) return [];
	const w = settings.webcam;
	if (w.webcamEnabled === false) return [];
	const out: Camera[] = [];
	if (Array.isArray(w.webcams)) {
		for (const cam of w.webcams.filter(isObj)) {
			const compat = isObj(cam.compat) ? cam.compat : {};
			const extras = isObj(cam.extras) ? cam.extras : {};
			const stream = resolveUrl(str(compat.stream) ?? str(extras.stream) ?? cam.stream, baseUrl);
			const snapshot = resolveUrl(str(compat.snapshot) ?? cam.snapshot, baseUrl);
			const id = str(cam.name) ?? `cam${out.length + 1}`;
			const c = camera(id, str(cam.displayName) ?? id, stream, snapshot, cam, 'octoprint');
			if (c && !out.some((x) => x.id === c.id)) out.push(c);
		}
	}
	if (!out.length) {
		const c = camera('classic', 'Webcam', resolveUrl(w.streamUrl, baseUrl), resolveUrl(w.snapshotUrl, baseUrl), w, 'octoprint');
		if (c) out.push(c);
	}
	return out;
}

export function toInfo(c: Camera): CameraInfo {
	const proxied = c.kind === 'mjpeg';
	return {
		id: c.id,
		label: c.label,
		snapshot: !!c.snapshotUrl,
		stream: c.kind,
		proxied,
		externalUrl: !proxied ? c.streamUrl : null,
		flipH: c.flipH,
		flipV: c.flipV,
		rotate90: c.rotate90,
		source: c.source
	};
}

const TTL_MS = 2 * 60_000;
const cache = new Map<string, { at: number; key: string; cams: Camera[] }>();

export async function cameras(printer: Printer): Promise<Camera[]> {
	const key = printer.updatedAt;
	const hit = cache.get(printer.id);
	if (hit && hit.key === key && Date.now() - hit.at < TTL_MS) return hit.cams;
	const cams = printer.webcamUrl ? camerasFromOverride(printer.webcamUrl, printer.baseUrl) : await backendFor(printer).cameras(printer.baseUrl);
	cache.set(printer.id, { at: Date.now(), key, cams });
	return cams;
}

/** The camera with this id, or the first one. */
export async function cameraFor(printer: Printer, id?: string | null): Promise<Camera | undefined> {
	const cams = await cameras(printer);
	return (id && cams.find((c) => c.id === id)) || cams[0];
}

/** Headers for a camera request: the API key only goes to OctoPrint's own origin. */
export function cameraHeaders(printer: Printer, url: string, apiKey: string | undefined): Record<string, string> {
	try {
		if (apiKey && new URL(url).origin === new URL(printer.baseUrl).origin) return { 'X-Api-Key': apiKey };
	} catch {}
	return {};
}

/**
 * One frame from a camera (`camId`, default the first), fetched by the server. The
 * response is the camera's image (not yet read). Throws 404 without a snapshot URL,
 * 502 when the camera answers with something other than an image.
 */
export async function fetchSnapshot(printer: Printer, camId?: string | null, timeoutMs = 8_000): Promise<{ type: string; res: Response }> {
	const cam = await cameraFor(printer, camId);
	if (!cam?.snapshotUrl) throw new OctoPrintError('This printer has no webcam snapshot URL', { status: 404, code: 'NO_SNAPSHOT' });
	let res: Response;
	try {
		res = await httpFetch(cam.snapshotUrl, { headers: cameraHeaders(printer, cam.snapshotUrl, getApiKey(printer.id)), signal: AbortSignal.timeout(timeoutMs) }, printer.verifyTls);
	} catch (err) {
		throw toOctoPrintError(err, new URL(cam.snapshotUrl).host);
	}
	const type = res.headers.get('content-type') ?? '';
	if (!res.ok || !type.startsWith('image/')) {
		await res.body?.cancel();
		throw new OctoPrintError(`The webcam answered ${res.status}${type ? ` (${type.split(';')[0]})` : ''}`, { status: 502, code: 'BAD_SNAPSHOT' });
	}
	return { type: type.split(';')[0].trim(), res };
}
