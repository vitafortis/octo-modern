/**
 * Loads a G-code file into a toolpath in a Web Worker (one per load, ended afterwards so
 * its memory goes back). The last couple of results are cached, so switching tabs or
 * reopening a preview doesn't download the file again.
 */
import type { Toolpath } from './parse.ts';
import type { WorkerReply, WorkerRequest } from './worker.ts';

export interface Loaded {
	toolpath: Toolpath;
	/** Download + parse, ms. */
	ms: number;
}

/** Points kept in memory: fewer on phones and small-memory devices. */
export function pointBudget(): number {
	const nav = navigator as Navigator & { deviceMemory?: number };
	const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	if ((nav.deviceMemory ?? 8) <= 2) return 800_000;
	if (coarse || (nav.deviceMemory ?? 8) <= 4) return 1_500_000;
	return 3_000_000;
}

/** Segments drawn per frame at full quality (the GPU side of the budget). */
export function frameBudget(): number {
	const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	return coarse ? 600_000 : 2_000_000;
}

const cache = new Map<string, Loaded>();
const MAX_CACHED = 2;

export const urls = {
	printerFile: (printerId: string, path: string) => `/api/printers/${encodeURIComponent(printerId)}/files/download?path=${encodeURIComponent(path)}`,
	libraryFile: (sourceId: string, path: string) => `/api/library/${encodeURIComponent(sourceId)}/download?path=${encodeURIComponent(path)}`
};

/**
 * Loads `url` (cache key `key`, e.g. including the file's size and date so a new upload
 * with the same name is fetched again).
 */
export function loadToolpath(url: string, key: string, opts: { onprogress?: (bytes: number, total: number | null) => void; signal?: AbortSignal } = {}): Promise<Loaded> {
	const hit = cache.get(key);
	if (hit) {
		cache.delete(key);
		cache.set(key, hit);
		return Promise.resolve(hit);
	}
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
		const end = () => {
			worker.terminate();
			opts.signal?.removeEventListener('abort', abort);
		};
		const abort = () => {
			end();
			reject(new DOMException('Cancelled', 'AbortError'));
		};
		if (opts.signal?.aborted) return abort();
		opts.signal?.addEventListener('abort', abort, { once: true });
		worker.onmessage = (e: MessageEvent<WorkerReply>) => {
			const m = e.data;
			if (m.type === 'progress') opts.onprogress?.(m.bytes, m.total);
			else if (m.type === 'done') {
				end();
				const loaded = { toolpath: m.toolpath, ms: m.ms };
				cache.set(key, loaded);
				while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
				resolve(loaded);
			} else {
				end();
				reject(new Error(m.message));
			}
		};
		worker.onerror = (e) => {
			end();
			reject(new Error(e.message || 'The preview worker failed'));
		};
		worker.postMessage({ type: 'load', url, maxPoints: pointBudget() } satisfies WorkerRequest);
	});
}
