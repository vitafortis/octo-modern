/** A fresh webcam snapshot for a notification. Best effort: null on any failure. */
import { shrinkJpeg } from '../history/jpeg.ts';
import { cameraFor, cameraHeaders } from '../octoprint/webcam.ts';
import { httpFetch } from '../octoprint/transport.ts';
import { getApiKey } from '../store.ts';
import type { Printer } from '#lib/types.ts';
import type { Image } from './types.ts';

/** Larger JPEGs are scaled down; every channel takes this much. */
export const MAX_IMAGE_BYTES = 1_500_000;

export async function webcamSnapshot(printer: Printer): Promise<Image | null> {
	try {
		const cam = await cameraFor(printer);
		if (!cam?.snapshotUrl) return null;
		const res = await httpFetch(cam.snapshotUrl, { headers: cameraHeaders(printer, cam.snapshotUrl, getApiKey(printer.id)), signal: AbortSignal.timeout(8_000) }, printer.verifyTls);
		const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
		if (!res.ok || !type.startsWith('image/')) {
			await res.body?.cancel();
			return null;
		}
		const data = new Uint8Array(await res.arrayBuffer());
		if (type === 'image/jpeg' || type === 'image/jpg') {
			const out = shrinkJpeg(data, MAX_IMAGE_BYTES);
			return out ? { data: out, type: 'image/jpeg' } : null;
		}
		return /^image\/(png|webp|gif)$/.test(type) && data.length <= MAX_IMAGE_BYTES ? { data, type } : null;
	} catch {
		return null;
	}
}
