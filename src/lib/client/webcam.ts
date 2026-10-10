import { api } from './api.ts';

export interface WebcamCaps {
	snapshot: boolean;
	stream: boolean;
	flipH: boolean;
	flipV: boolean;
	rotate90: boolean;
	source: 'override' | 'octoprint' | 'none';
}

const NONE: WebcamCaps = { snapshot: false, stream: false, flipH: false, flipV: false, rotate90: false, source: 'none' };
const cache = new Map<string, { at: number; caps: Promise<WebcamCaps> }>();

/** What a printer's webcam offers (cached for a minute per page load). */
export function webcamCaps(printerId: string): Promise<WebcamCaps> {
	const hit = cache.get(printerId);
	if (hit && Date.now() - hit.at < 60_000) return hit.caps;
	const caps = api.get<WebcamCaps>(`/api/printers/${encodeURIComponent(printerId)}/webcam`).catch(() => NONE);
	cache.set(printerId, { at: Date.now(), caps });
	return caps;
}

/** CSS transform for OctoPrint's flip/rotate webcam settings. */
export function webcamTransform(c: Pick<WebcamCaps, 'flipH' | 'flipV' | 'rotate90'>): string {
	const parts = [];
	if (c.rotate90) parts.push('rotate(-90deg)');
	if (c.flipH) parts.push('scaleX(-1)');
	if (c.flipV) parts.push('scaleY(-1)');
	return parts.join(' ');
}
