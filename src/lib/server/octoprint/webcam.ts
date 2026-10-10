/**
 * Webcam URLs for a printer: the admin's override, or what OctoPrint's settings
 * report (cached for a few minutes). Images are proxied through octo·modern so the
 * browser never needs to reach the camera (or OctoPrint) directly.
 */
import { clientFor } from './manager.ts';
import { parseWebcam } from './parse.ts';
import type { Printer } from '#lib/types.ts';

export interface WebcamInfo {
	snapshotUrl: string | null;
	streamUrl: string | null;
	flipH: boolean;
	flipV: boolean;
	rotate90: boolean;
	/** `override`: the server's webcam URL field; `octoprint`: OctoPrint's webcam settings. */
	source: 'override' | 'octoprint' | 'none';
}

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; key: string; info: WebcamInfo }>();

/** mjpg-streamer / ustreamer convention: `?action=stream` ↔ `?action=snapshot`, `/stream` ↔ `/snapshot`. */
export function siblingUrl(url: string, want: 'snapshot' | 'stream'): string | null {
	const other = want === 'snapshot' ? 'stream' : 'snapshot';
	if (new RegExp(`action=${other}`, 'i').test(url)) return url.replace(new RegExp(`action=${other}`, 'i'), `action=${want}`);
	if (new RegExp(`/${other}(\\?|$)`, 'i').test(url)) return url.replace(new RegExp(`/${other}(\\?|$)`, 'i'), `/${want}$1`);
	return null;
}

/** Interprets the override field: a stream or snapshot URL, absolute or relative to the OctoPrint host. */
export function fromOverride(raw: string, baseUrl: string): Pick<WebcamInfo, 'snapshotUrl' | 'streamUrl'> {
	const url = new URL(raw, `${baseUrl}/`).href;
	const isSnapshot = /action=snapshot|\/snapshot(\?|$)|\.(jpe?g|png|webp)(\?|$)/i.test(url);
	return isSnapshot ? { snapshotUrl: url, streamUrl: siblingUrl(url, 'stream') } : { streamUrl: url, snapshotUrl: siblingUrl(url, 'snapshot') };
}

export async function webcamInfo(printer: Printer): Promise<WebcamInfo> {
	const key = `${printer.updatedAt}`;
	const hit = cache.get(printer.id);
	if (hit && hit.key === key && Date.now() - hit.at < TTL_MS) return hit.info;
	let info: WebcamInfo;
	if (printer.webcamUrl) {
		info = { ...fromOverride(printer.webcamUrl, printer.baseUrl), flipH: false, flipV: false, rotate90: false, source: 'override' };
	} else {
		const w = parseWebcam(await clientFor(printer).settings(), printer.baseUrl);
		const has = w.enabled && (w.snapshotUrl || w.streamUrl);
		info = {
			snapshotUrl: has ? (w.snapshotUrl ?? (w.streamUrl ? siblingUrl(w.streamUrl, 'snapshot') : null)) : null,
			streamUrl: has ? w.streamUrl : null,
			flipH: w.flipH,
			flipV: w.flipV,
			rotate90: w.rotate90,
			source: has ? 'octoprint' : 'none'
		};
	}
	cache.set(printer.id, { at: Date.now(), key, info });
	return info;
}

/** Headers for a camera request: the API key only goes to OctoPrint's own origin. */
export function cameraHeaders(printer: Printer, url: string, apiKey: string | undefined): Record<string, string> {
	try {
		if (apiKey && new URL(url).origin === new URL(printer.baseUrl).origin) return { 'X-Api-Key': apiKey };
	} catch {}
	return {};
}
