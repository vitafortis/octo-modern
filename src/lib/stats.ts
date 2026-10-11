/**
 * The Stats page: types shared by the server and the browser. Pure.
 */
import type { PrintResult } from './history.ts';

export type StatsRange = '30d' | '90d' | '12m' | 'all';
export const STATS_RANGES: StatsRange[] = ['30d', '90d', '12m', 'all'];
export const RANGE_LABEL: Record<StatsRange, string> = { '30d': '30 days', '90d': '90 days', '12m': '12 months', all: 'All time' };

/** How the charts are bucketed: days for 30 days, weeks (Monday first) for 90 days, months beyond. */
export type Granularity = 'day' | 'week' | 'month';

export interface StatsPrinter {
	id: string;
	name: string;
	/** Removed since (admins still see its history). */
	removed: boolean;
}

export interface StatsBucket {
	/** `YYYY-MM-DD` (day, or the Monday of a week) or `YYYY-MM` (month), in the report's time zone. */
	key: string;
	/** The bucket's bounds as UTC instants (end exclusive). */
	start: string;
	end: string;
	/** Seconds of print time per printer id, finished prints, by start time. */
	printTime: Record<string, number>;
	success: number;
	failed: number;
	cancelled: number;
}

export interface StatsTotals {
	/** Finished prints (success + failed + cancelled). */
	prints: number;
	success: number;
	failed: number;
	cancelled: number;
	successRate: number | null;
	/** Seconds. */
	printTime: number;
	avgPrintTime: number | null;
	filamentMm: number;
	/** Grams: the entry's own figure where it has one, else from the default material's density. */
	filamentG: number;
	cost: number;
	/** Prints that had a cost; 0 hides the cost tile. */
	costed: number;
	currency: string;
}

export interface FileStats {
	path: string;
	file: string;
	prints: number;
	success: number;
	successRate: number | null;
	/** Average print time of its successful prints (of all finished ones if none succeeded). */
	avgPrintTime: number | null;
	lastPrinted: string;
	/** The printer of the latest print. */
	printerId: string;
}

export interface ReasonStats {
	result: Extract<PrintResult, 'failed' | 'cancelled'>;
	/** OctoPrint's reason (`error`, `disconnected`…), or null when it gave none. */
	reason: string | null;
	count: number;
}

export interface Utilisation {
	printerId: string;
	/** Seconds spent printing within the range (prints overlapping its start are clipped). */
	printSecs: number;
	/** printSecs / the range's length, 0–1. */
	share: number;
}

export interface MaterialStats {
	material: string;
	prints: number;
	filamentMm: number;
	filamentG: number;
}

export interface SpoolStats {
	spoolId: number;
	/** From Spoolman when it answers, else null (shown as "Spool #id"). */
	name: string | null;
	vendor: string | null;
	material: string | null;
	color: string | null;
	prints: number;
	filamentMm: number;
	filamentG: number | null;
}

export interface StatsReport {
	range: StatsRange;
	granularity: Granularity;
	/** IANA zone the buckets follow. */
	timeZone: string;
	/** Range start (UTC instant), null for "all" without any prints. */
	from: string | null;
	to: string;
	/** Length of the range, seconds (the denominator of utilisation). */
	rangeSecs: number;
	/** Printers in the report, in a stable order (series colours follow it). */
	printers: StatsPrinter[];
	totals: StatsTotals;
	buckets: StatsBucket[];
	files: FileStats[];
	reasons: ReasonStats[];
	utilisation: Utilisation[];
	materials: MaterialStats[];
	/** Null when Spoolman isn't set up or no print in the range used a known spool. */
	spools: SpoolStats[] | null;
}
