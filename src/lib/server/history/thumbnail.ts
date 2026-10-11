/**
 * The picture kept with each print: a webcam snapshot taken when it ends (or the
 * slicer's thumbnail when there's no camera), at most `MAX_BYTES`. Larger JPEGs are
 * decoded, scaled down and re-encoded in pure JS (jpeg-js), so no native image
 * library is needed.
 */
import { MAX_BYTES, shrinkJpeg } from './jpeg.ts';
import { cameraFor, cameraHeaders } from '../octoprint/webcam.ts';
import { httpFetch } from '../octoprint/transport.ts';
import { backendFor } from '../backend/index.ts';
import { getApiKey } from '../store.ts';
import type { Printer } from '#lib/types.ts';

/** A webcam snapshot (or the file's slicer thumbnail), ready to store. Best effort: null on any failure. */
export async function captureThumbnail(printer: Printer, slicerThumbnail: string | null): Promise<{ data: Uint8Array; type: string } | null> {
	try {
		const cam = await cameraFor(printer);
		if (cam?.snapshotUrl) {
			const res = await httpFetch(cam.snapshotUrl, { headers: cameraHeaders(printer, cam.snapshotUrl, getApiKey(printer.id)), signal: AbortSignal.timeout(8_000) }, printer.verifyTls);
			if (res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')) {
				const small = shrinkJpeg(new Uint8Array(await res.arrayBuffer()));
				if (small) return { data: small, type: 'image/jpeg' };
			} else await res.body?.cancel();
		}
	} catch {
		// No camera, or it didn't answer: try the slicer thumbnail.
	}
	if (!slicerThumbnail) return null;
	try {
		const backend = backendFor(printer);
		const src = backend.thumbnailSource(slicerThumbnail);
		if (!src) return null;
		const res = await backend.thumbnail(src, { timeoutMs: 8_000 });
		const type = (res.headers.get('content-type') ?? '').split(';')[0];
		const data = new Uint8Array(await res.arrayBuffer());
		if (type === 'image/jpeg') {
			const small = shrinkJpeg(data);
			return small ? { data: small, type } : null;
		}
		if (/^image\/(png|webp|gif)$/.test(type) && data.length <= MAX_BYTES) return { data, type };
	} catch {}
	return null;
}
