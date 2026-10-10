import { connect } from 'node:net';

const cache = new Map<string, { ok: boolean; at: number }>();

/** TCP reachability check, cached briefly so repeated scans stay fast. */
export function probe(host: string, port: number, timeoutMs = 1200, { cached = true } = {}): Promise<boolean> {
	const key = `${host}:${port}`;
	const hit = cached ? cache.get(key) : undefined;
	if (hit && Date.now() - hit.at < 15_000) return Promise.resolve(hit.ok);
	return new Promise((resolve) => {
		const socket = connect({ host: host.replace(/^\[|\]$/g, ''), port });
		const done = (ok: boolean) => {
			socket.destroy();
			cache.set(key, { ok, at: Date.now() });
			resolve(ok);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

/** Runs `fn` over `items` with bounded concurrency, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		})
	);
	return out;
}
