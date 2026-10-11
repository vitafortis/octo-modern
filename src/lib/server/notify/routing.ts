/**
 * Who gets what: rules (printers × events → channels), quiet hours, and the de-dupe
 * and rate limit that keep a flapping printer from spamming. Pure apart from the
 * limiter's memory, with the clock passed in.
 */
import type { EventKind, QuietHours, Rule } from '#lib/notify.ts';

/** Channel ids the enabled rules send this event to, in rule order, each once. */
export function routeEvent(rules: Rule[], kind: EventKind, printerId: string | null | undefined): string[] {
	const out = new Set<string>();
	for (const r of rules) {
		if (!r.enabled || !r.events.includes(kind)) continue;
		// A printer-less event (e.g. from another feature) only matches "all printers" rules.
		if (r.printers !== 'all' && (!printerId || !r.printers.includes(printerId))) continue;
		for (const c of r.channels) out.add(c);
	}
	return [...out];
}

const minutes = (hhmm: string) => {
	const [h, m] = hhmm.split(':').map(Number);
	return h * 60 + m;
};

/**
 * Whether `at` (server local time) falls in the quiet period. A period that crosses
 * midnight (22:00–07:00) belongs to the day it starts on, for the `days` filter.
 */
export function inQuietHours(q: QuietHours, at: Date): boolean {
	if (!q.enabled) return false;
	const start = minutes(q.start);
	const end = minutes(q.end);
	if (start === end) return false;
	const now = at.getHours() * 60 + at.getMinutes();
	const day = at.getDay();
	const dayOk = (d: number) => !q.days.length || q.days.includes(d);
	if (start < end) return now >= start && now < end && dayOk(day);
	// Overnight: the evening part is today's period, the morning part yesterday's.
	if (now >= start) return dayOk(day);
	if (now < end) return dayOk((day + 6) % 7);
	return false;
}

export type LimitVerdict = 'ok' | 'deduped' | 'rate_limited';

/**
 * Per channel: the same key at most once per de-dupe window, and at most `max`
 * messages per 10 minutes. Remembers what it let through (in memory).
 */
export class Limiter {
	private seen = new Map<string, number>();
	private sent = new Map<string, number[]>();

	check(channelId: string, key: string, opts: { dedupeMs: number; max: number }, now = Date.now()): LimitVerdict {
		const k = `${channelId}\u0000${key}`;
		const last = this.seen.get(k);
		if (opts.dedupeMs > 0 && last != null && now - last < opts.dedupeMs) return 'deduped';
		const window = (this.sent.get(channelId) ?? []).filter((t) => now - t < 10 * 60_000);
		if (window.length >= opts.max) {
			this.sent.set(channelId, window);
			return 'rate_limited';
		}
		window.push(now);
		this.sent.set(channelId, window);
		this.seen.set(k, now);
		if (this.seen.size > 5000) for (const [key2, t] of this.seen) if (now - t > 24 * 3600_000) this.seen.delete(key2);
		return 'ok';
	}

	reset() {
		this.seen.clear();
		this.sent.clear();
	}
}
