/// <reference lib="webworker" />
/**
 * The toolpath parser's Web Worker: downloads a G-code file in ranged chunks (resuming
 * a chunk where it broke off if the connection drops), parses it while it streams in,
 * and hands back the typed arrays (transferred, not copied).
 *
 *   → { type: 'load', url, maxPoints }
 *   ← { type: 'progress', bytes, total }   (a few times a second)
 *   ← { type: 'done', toolpath, ms, fetchMs }
 *   ← { type: 'error', message }
 */
import { GcodeParser, isBinaryGcode, type Toolpath } from './parse.ts';

export type WorkerRequest = { type: 'load'; url: string; maxPoints: number; chunkBytes?: number };
export type WorkerReply =
	| { type: 'progress'; bytes: number; total: number | null }
	| { type: 'done'; toolpath: Toolpath; ms: number }
	| { type: 'error'; message: string };

const post = (m: WorkerReply, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

const CHUNK = 16 * 1024 * 1024;
const RETRIES = 3;

async function errorText(res: Response): Promise<string> {
	try {
		const j = (await res.json()) as { message?: string; hint?: string };
		if (j?.message) return j.hint ? `${j.message}. ${j.hint}` : j.message;
	} catch {}
	return `The server answered ${res.status}`;
}

async function load(req: WorkerRequest) {
	const started = performance.now();
	const parser = new GcodeParser({ maxPoints: req.maxPoints });
	const chunk = req.chunkBytes ?? CHUNK;
	let total: number | null = null;
	let lastPost = 0;
	let checked = false;
	const progress = (force = false) => {
		const now = performance.now();
		if (!force && now - lastPost < 150) return;
		lastPost = now;
		post({ type: 'progress', bytes: parser.consumed, total });
	};
	const feed = async (body: ReadableStream<Uint8Array>, limit: number) => {
		const reader = body.getReader();
		let got = 0;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!checked) {
				checked = true;
				if (isBinaryGcode(value)) throw new Error('This is binary G-code (.bgcode); the preview reads plain-text G-code only');
			}
			const take = got + value.length > limit ? value.subarray(0, limit - got) : value;
			parser.push(take);
			got += take.length;
			progress();
			if (got >= limit) {
				await reader.cancel().catch(() => {});
				break;
			}
		}
		return got;
	};

	let failures = 0;
	for (;;) {
		const from = parser.consumed;
		if (total !== null && from >= total) break;
		const to = from + chunk - 1;
		let res: Response;
		try {
			res = await fetch(req.url, { headers: { range: `bytes=${from}-${to}` }, credentials: 'same-origin' });
		} catch (err) {
			if (++failures > RETRIES) throw err;
			await new Promise((r) => setTimeout(r, 500 * failures));
			continue;
		}
		if (res.status === 416 && total !== null) break;
		if (!res.ok) throw new Error(await errorText(res));
		try {
			if (res.status === 200) {
				// No range support: the whole file in one stream (only valid from the start).
				if (from !== 0) throw new Error('The server stopped honouring ranges mid-file');
				const len = Number(res.headers.get('content-length'));
				total = Number.isFinite(len) && len > 0 ? len : null;
				await feed(res.body!, Infinity);
				break;
			}
			const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
			if (m) total = Number(m[1]);
			const want = (total !== null ? Math.min(to, total - 1) : to) - from + 1;
			const got = await feed(res.body!, want);
			failures = 0;
			if (total === null && got < want) break;
		} catch (err) {
			// A broken stream resumes from the last byte parsed; other errors end the load.
			if (err instanceof TypeError && ++failures <= RETRIES) {
				await new Promise((r) => setTimeout(r, 500 * failures));
				continue;
			}
			throw err;
		}
	}
	progress(true);
	const toolpath = parser.finish();
	const ms = Math.round(performance.now() - started);
	post({ type: 'done', toolpath, ms }, [toolpath.positions.buffer, toolpath.kinds.buffer, toolpath.offsets.buffer, toolpath.layerStart.buffer, toolpath.layerZ.buffer]);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
	if (e.data?.type !== 'load') return;
	load(e.data).catch((err) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
};
