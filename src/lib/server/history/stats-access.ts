/**
 * Parsing and access-checking a Stats page request: the range, the time zone and the
 * printer filter, limited to the printers the user can see (history/access.ts).
 */
import { NotFound } from '../http.ts';
import { historyScope } from './access.ts';
import { serverTimeZone, validTimeZone } from './buckets.ts';
import type { ReportQuery } from './report.ts';
import { STATS_RANGES, type StatsRange } from '#lib/stats.ts';
import type { User } from '#lib/types.ts';

export function statsQuery(user: User | null, url: URL): ReportQuery {
	const p = url.searchParams;
	const raw = p.get('range') ?? '';
	const range: StatsRange = STATS_RANGES.includes(raw as StatsRange) ? (raw as StatsRange) : '30d';
	const scope = historyScope(user);
	const printer = p.get('printer') || null;
	// A printer the user can't see doesn't exist for them (admins may pick removed ones).
	if (printer && scope && !scope.includes(printer)) throw new NotFound('Printer not found');
	return { range, scope, printer, timeZone: validTimeZone(p.get('tz')) ?? serverTimeZone() };
}
