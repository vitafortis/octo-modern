import { api } from './api.ts';

/** One camera as the server describes it (see server/octoprint/webcam.ts). */
export interface CameraInfo {
	id: string;
	label: string;
	snapshot: boolean;
	stream: 'mjpeg' | 'hls' | 'webrtc' | null;
	proxied: boolean;
	externalUrl: string | null;
	flipH: boolean;
	flipV: boolean;
	rotate90: boolean;
	source: 'override' | 'octoprint';
}

const cache = new Map<string, { at: number; cams: Promise<CameraInfo[]> }>();

/** A printer's cameras (cached for a minute per page load). */
export function cameras(printerId: string, fresh = false): Promise<CameraInfo[]> {
	const hit = cache.get(printerId);
	if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.cams;
	const cams = api
		.get<{ cameras: CameraInfo[] }>(`/api/printers/${encodeURIComponent(printerId)}/webcam`)
		.then((r) => r.cameras)
		.catch(() => []);
	cache.set(printerId, { at: Date.now(), cams });
	return cams;
}

export const streamUrl = (printerId: string, cam: string) => `/api/printers/${encodeURIComponent(printerId)}/webcam/stream?cam=${encodeURIComponent(cam)}`;
export const snapshotUrl = (printerId: string, cam: string, t = Date.now()) =>
	`/api/printers/${encodeURIComponent(printerId)}/webcam/snapshot?cam=${encodeURIComponent(cam)}&t=${t}`;

/** CSS transform for OctoPrint's flip/rotate webcam settings. */
export function webcamTransform(c: Pick<CameraInfo, 'flipH' | 'flipV' | 'rotate90'>): string {
	const parts = [];
	if (c.rotate90) parts.push('rotate(-90deg)');
	if (c.flipH) parts.push('scaleX(-1)');
	if (c.flipV) parts.push('scaleY(-1)');
	return parts.join(' ') || 'none';
}

/**
 * Svelte action: calls `onchange(true/false)` as the element enters/leaves the viewport
 * and the tab is shown/hidden, so cameras only load while someone can see them.
 */
export function visible(node: HTMLElement, onchange: (v: boolean) => void) {
	let inView = false;
	const emit = () => onchange(inView && document.visibilityState === 'visible');
	const io = new IntersectionObserver((entries) => {
		inView = entries.some((e) => e.isIntersecting);
		emit();
	});
	io.observe(node);
	document.addEventListener('visibilitychange', emit);
	return {
		destroy() {
			io.disconnect();
			document.removeEventListener('visibilitychange', emit);
		}
	};
}
