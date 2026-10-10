/**
 * Coalesces bursts of small, repeated actions (clicking the jog buttons ten times) into
 * one audit entry, so the log stays readable: entries with the same key are collected
 * until `idleMs` passes without another one, the burst gets `maxAgeMs` old, or it
 * reaches `maxItems`, then written as one.
 */

export interface Burst<T> {
	items: T[];
	firstAt: number;
}

export class Coalescer<T> {
	private pending = new Map<string, { burst: Burst<T>; timer: ReturnType<typeof setTimeout>; flush: (b: Burst<T>) => void }>();
	readonly idleMs: number;
	readonly maxAgeMs: number;
	readonly maxItems: number;
	private now: () => number;

	constructor(opts: { idleMs?: number; maxAgeMs?: number; maxItems?: number; now?: () => number } = {}) {
		this.idleMs = opts.idleMs ?? 5_000;
		this.maxAgeMs = opts.maxAgeMs ?? 60_000;
		this.maxItems = opts.maxItems ?? 100;
		this.now = opts.now ?? Date.now;
	}

	/** Adds an item to the burst for `key`; `flush` writes the burst when it closes (the latest one wins). */
	add(key: string, item: T, flush: (b: Burst<T>) => void) {
		const cur = this.pending.get(key);
		if (cur) {
			clearTimeout(cur.timer);
			cur.burst.items.push(item);
			cur.flush = flush;
			if (cur.burst.items.length >= this.maxItems || this.now() - cur.burst.firstAt >= this.maxAgeMs) return this.flush(key);
			cur.timer = this.timer(key);
			return;
		}
		this.pending.set(key, { burst: { items: [item], firstAt: this.now() }, timer: this.timer(key), flush });
	}

	private timer(key: string) {
		const t = setTimeout(() => this.flush(key), this.idleMs);
		t.unref?.();
		return t;
	}

	/** Writes the burst for `key` now (e.g. before an unrelated action, to keep the order). */
	flush(key: string) {
		const cur = this.pending.get(key);
		if (!cur) return;
		clearTimeout(cur.timer);
		this.pending.delete(key);
		cur.flush(cur.burst);
	}

	flushAll() {
		for (const key of [...this.pending.keys()]) this.flush(key);
	}

	get size() {
		return this.pending.size;
	}
}
