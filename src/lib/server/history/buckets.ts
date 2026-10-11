/**
 * Calendar buckets for the Stats page, in a time zone. Pure.
 *
 * Time zone choice: the browser sends its IANA zone (`Intl…resolvedOptions().timeZone`)
 * and the server buckets in it, so "Monday" and "October" match the viewer's calendar,
 * DST changes included (a fixed UTC offset would shift every bucket after a change).
 * Without a valid zone the server's own (`TZ`, default UTC) is used. The bounds are
 * computed here as UTC instants and handed to SQL, which only compares ISO strings.
 */
import type { Granularity, StatsRange } from '#lib/stats.ts';

const DAY = 86_400_000;

/** The zone if Intl knows it, else null. */
export function validTimeZone(tz: unknown): string | null {
	if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

/** The server's zone: `TZ` when valid, else what the runtime reports (UTC in the container). */
export function serverTimeZone(): string {
	return validTimeZone(process.env.TZ) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
		formatters.set(tz, f);
	}
	return f;
}

/** Wall-clock fields of an instant in a zone (month 1–12). */
export function localParts(t: number, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
	const p: Record<string, number> = {};
	for (const part of fmt(tz).formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = Number(part.value);
	return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, min: p.minute, s: p.second };
}

/** Local time minus UTC at an instant, ms. */
function offset(t: number, tz: string): number {
	const p = localParts(t, tz);
	return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(t / 1000) * 1000;
}

/**
 * The first instant of a local calendar day (normally midnight; where midnight is
 * skipped by a DST change, the first hour that exists). Month/day may overflow
 * (`d = 0`, `m = 13`), as with Date.UTC.
 */
export function startOfDay(y: number, m: number, d: number, tz: string): number {
	const norm = new Date(Date.UTC(y, m - 1, d));
	const [Y, M, D] = [norm.getUTCFullYear(), norm.getUTCMonth() + 1, norm.getUTCDate()];
	const wall = norm.getTime();
	let t = wall - offset(wall, tz);
	t = wall - offset(t, tz);
	// Midnight didn't exist (we landed late on the day before): step forward to the first hour of the day.
	for (let i = 0; i < 4; i++) {
		const p = localParts(t, tz);
		if (p.y === Y && p.m === M && p.d === D) break;
		t += 3_600_000;
	}
	// …and never past the true start (when an earlier hour of the day also exists).
	while (true) {
		const p = localParts(t - 3_600_000, tz);
		if (!(p.y === Y && p.m === M && p.d === D)) break;
		t -= 3_600_000;
	}
	return t;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The local date of an instant, `YYYY-MM-DD`. */
export function localDate(t: number, tz: string): string {
	const p = localParts(t, tz);
	return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Start of the bucket an instant falls in, as local y/m/d, and its key. */
function bucketStart(t: number, g: Granularity, tz: string): { y: number; m: number; d: number } {
	const p = localParts(t, tz);
	if (g === 'month') return { y: p.y, m: p.m, d: 1 };
	if (g === 'day') return { y: p.y, m: p.m, d: p.d };
	const weekday = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7; // Monday = 0
	return { y: p.y, m: p.m, d: p.d - weekday };
}

function keyOf(y: number, m: number, d: number, g: Granularity): string {
	const n = new Date(Date.UTC(y, m - 1, d));
	const ym = `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}`;
	return g === 'month' ? ym : `${ym}-${pad(n.getUTCDate())}`;
}

export interface Bucket {
	key: string;
	start: number;
	end: number;
}

/** Consecutive buckets covering [from, to), aligned to local days, Mondays or months. At most `max`, the latest. */
export function makeBuckets(from: number, to: number, g: Granularity, tz: string, max = 400): Bucket[] {
	const out: Bucket[] = [];
	let { y, m, d } = bucketStart(from, g, tz);
	let start = startOfDay(y, m, d, tz);
	while (start < to) {
		const next = g === 'month' ? { y, m: m + 1, d: 1 } : { y, m, d: d + (g === 'week' ? 7 : 1) };
		const end = startOfDay(next.y, next.m, next.d, tz);
		out.push({ key: keyOf(y, m, d, g), start, end });
		({ y, m, d } = next);
		start = end;
	}
	return out.slice(-max);
}

/**
 * Where a range starts and how it is bucketed. `30d`/`90d` start at local midnight 29/89
 * days before today, `12m` on the first of the month eleven months back; `all` at the
 * first print (`firstPrint`), bucketed by day, week or month depending on how long ago.
 */
export function rangeStart(range: StatsRange, now: number, tz: string, firstPrint: number | null): { from: number | null; granularity: Granularity } {
	const p = localParts(now, tz);
	if (range === '30d') return { from: startOfDay(p.y, p.m, p.d - 29, tz), granularity: 'day' };
	if (range === '90d') return { from: startOfDay(p.y, p.m, p.d - 89, tz), granularity: 'week' };
	if (range === '12m') return { from: startOfDay(p.y, p.m - 11, 1, tz), granularity: 'month' };
	if (firstPrint == null || !Number.isFinite(firstPrint)) return { from: null, granularity: 'month' };
	const span = now - firstPrint;
	return { from: Math.min(firstPrint, now), granularity: span <= 31 * DAY ? 'day' : span <= 182 * DAY ? 'week' : 'month' };
}
