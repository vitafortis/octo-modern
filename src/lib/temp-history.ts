import type { TempSample } from './printer.ts';

/**
 * A fixed-capacity ring buffer of temperature samples covering a time window
 * (30 minutes by default). Samples arrive roughly every 0.5–2 s; anything older
 * than the window, or beyond the capacity, is dropped. Samples are kept in time
 * order: one older than the newest is ignored, one at the same time replaces it.
 *
 * Used on the server (one per printer) and in the browser (the chart's buffer).
 */
export class TempHistory {
	readonly windowMs: number;
	readonly capacity: number;
	private buf: (TempSample | undefined)[];
	/** Index of the oldest sample. */
	private head = 0;
	private count = 0;

	constructor(windowMs = 30 * 60_000, capacity = 3600) {
		this.windowMs = windowMs;
		this.capacity = Math.max(1, capacity);
		this.buf = new Array(this.capacity);
	}

	get size(): number {
		return this.count;
	}

	private at(i: number): TempSample {
		return this.buf[(this.head + i) % this.capacity]!;
	}

	newest(): TempSample | undefined {
		return this.count ? this.at(this.count - 1) : undefined;
	}

	oldest(): TempSample | undefined {
		return this.count ? this.at(0) : undefined;
	}

	/** Adds a sample; returns false when it was out of order and ignored. */
	push(sample: TempSample): boolean {
		const last = this.newest();
		if (last && sample.t < last.t) return false;
		if (last && sample.t === last.t) {
			this.buf[(this.head + this.count - 1) % this.capacity] = sample;
			return true;
		}
		if (this.count === this.capacity) {
			this.buf[this.head] = sample;
			this.head = (this.head + 1) % this.capacity;
		} else {
			this.buf[(this.head + this.count) % this.capacity] = sample;
			this.count++;
		}
		this.prune(sample.t);
		return true;
	}

	/** Drops samples older than the window, measured from `now` (default: the newest sample). */
	prune(now = this.newest()?.t ?? 0) {
		const cutoff = now - this.windowMs;
		while (this.count && this.at(0).t < cutoff) {
			this.buf[this.head] = undefined;
			this.head = (this.head + 1) % this.capacity;
			this.count--;
		}
	}

	/** Samples at or after `since` (epoch ms), oldest first. */
	since(since = -Infinity): TempSample[] {
		const out: TempSample[] = [];
		for (let i = 0; i < this.count; i++) {
			const s = this.at(i);
			if (s.t >= since) out.push(s);
		}
		return out;
	}

	/**
	 * Merges older samples in (e.g. OctoPrint's history after a reconnect, which the
	 * in-order `push` would ignore). On equal times the merged-in sample wins.
	 */
	merge(samples: TempSample[]) {
		const byTime = new Map<number, TempSample>();
		for (const s of this.toArray()) byTime.set(s.t, s);
		for (const s of samples) byTime.set(s.t, s);
		const all = [...byTime.values()].sort((a, b) => a.t - b.t);
		this.clear();
		for (const s of all.slice(-this.capacity)) this.push(s);
	}

	toArray(): TempSample[] {
		return this.since();
	}

	clear() {
		this.buf = new Array(this.capacity);
		this.head = 0;
		this.count = 0;
	}
}
