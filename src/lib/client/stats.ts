/**
 * The Stats page from the browser: the report, its CSV, and labels for its buckets.
 */
import { api } from './api.ts';
import type { Granularity, StatsRange, StatsReport } from '#lib/stats.ts';

/** The browser's IANA zone, so the server buckets by the viewer's calendar. */
export const browserTimeZone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
	} catch {
		return '';
	}
};

function query(range: StatsRange, printer: string) {
	const q = new URLSearchParams({ range });
	if (printer) q.set('printer', printer);
	const tz = browserTimeZone();
	if (tz) q.set('tz', tz);
	return q;
}

export const loadStats = (range: StatsRange, printer: string, signal?: AbortSignal) => api.get<StatsReport>(`/api/stats?${query(range, printer)}`, signal);

/** The per-print rows of the range, through the history's CSV export (same columns, same escaping). */
export function statsCsvUrl(r: Pick<StatsReport, 'from' | 'to'>, printer: string): string {
	const q = new URLSearchParams();
	if (r.from) q.set('from', r.from);
	q.set('to', r.to);
	if (printer) q.set('printer', printer);
	return `/api/history/export.csv?${q}`;
}

/** A bucket key (`YYYY-MM-DD` or `YYYY-MM`) as a local date at noon, safe from zone shifts. */
function keyDate(key: string): Date {
	const [y, m, d] = key.split('-').map(Number);
	return new Date(y, m - 1, d || 1, 12);
}

/** Short axis label. */
export function bucketLabel(key: string, g: Granularity): string {
	const d = keyDate(key);
	if (g === 'month') return d.toLocaleDateString(undefined, d.getMonth() === 0 ? { month: 'short', year: '2-digit' } : { month: 'short' });
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Tooltip/table label. */
export function bucketTitle(key: string, g: Granularity): string {
	const d = keyDate(key);
	if (g === 'month') return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
	if (g === 'week') return `Week of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
	return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Hours with a sensible precision. */
export function hours(secs: number): string {
	const h = secs / 3600;
	if (!h) return '0 h';
	return `${h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString()} h`;
}
