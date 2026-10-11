/**
 * Reads the start of a G-code file from the printer, just far enough to see its start
 * block: a ranged download (`Range: bytes=0-…`; a server that ignores it is read as a
 * stream and dropped early), stopped at the first layer change or at `cap` bytes.
 */
import type { Origin, PrinterBackend } from '../backend/types.ts';
import { isLayerMarker } from '#lib/preprint.ts';

/** Enough for big embedded thumbnails (they're comments before the start G-code). */
export const HEAD_CAP = 1024 * 1024;

/**
 * Lines of the file up to its first layer change (or the cap). Null when the file can't
 * be read: SD card files, a missing file, or an error.
 */
export async function readHead(backend: PrinterBackend, origin: Origin, path: string, opts: { cap?: number; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string[] | null> {
	if (origin === 'sdcard') return null;
	const cap = opts.cap ?? HEAD_CAP;
	let res: Response;
	try {
		res = await backend.download(path, { headers: { range: `bytes=0-${cap - 1}` }, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 30_000 });
	} catch {
		return null;
	}
	if (!(res.status === 200 || res.status === 206) || !res.body) {
		await res.body?.cancel().catch(() => {});
		return null;
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: false });
	const lines: string[] = [];
	let partial = '';
	let read = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const take = Math.min(value.length, cap - read);
			read += take;
			partial += decoder.decode(value.subarray(0, take), { stream: true });
			const parts = partial.split(/\r?\n/);
			partial = parts.pop() ?? '';
			for (const line of parts) {
				if (isLayerMarker(line)) return lines;
				lines.push(line);
			}
			if (read >= cap) return lines;
		}
		partial += decoder.decode();
		if (partial && !isLayerMarker(partial)) lines.push(partial);
		return lines;
	} catch {
		return lines.length ? lines : null;
	} finally {
		await reader.cancel().catch(() => {});
	}
}
