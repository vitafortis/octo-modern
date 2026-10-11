/**
 * Print history and timelapses: types shared by the server and the browser. Pure.
 */
import type { Tone } from './printer.ts';

/** `printing`/`paused` while the job runs; the rest once it ended. */
export type PrintResult = 'printing' | 'paused' | 'success' | 'failed' | 'cancelled';

export const RESULTS: PrintResult[] = ['success', 'failed', 'cancelled', 'printing', 'paused'];

export const RESULT_LABEL: Record<PrintResult, string> = {
	printing: 'Printing',
	paused: 'Paused',
	success: 'Success',
	failed: 'Failed',
	cancelled: 'Cancelled'
};

export function resultTone(r: PrintResult): Tone {
	return r === 'success' ? 'success' : r === 'failed' ? 'danger' : r === 'cancelled' ? 'warning' : 'primary';
}

/** One print, as octo·modern recorded it (or imported it from OctoPrint). */
export interface PrintRecord {
	id: number;
	printerId: string;
	/** Copied when recorded, so entries outlive a renamed or removed printer. */
	printerName: string;
	/** Display name of the file. */
	file: string;
	/** Path within its origin, e.g. `parts/benchy.gcode`. */
	path: string;
	origin: 'local' | 'sdcard' | string;
	startedAt: string;
	endedAt: string | null;
	/** Seconds: OctoPrint's print time when it reported one, else end minus start. */
	durationS: number | null;
	result: PrintResult;
	/** Why it failed (`error`, `disconnected`…), when known. */
	reason: string | null;
	/** Filament used, mm summed over tools (the analysis × how far the print got). */
	filamentMm: number | null;
	/** OctoPrint's estimate from the analysis, seconds. */
	estimatedS: number | null;
	/** 0–100, how far the print got. */
	completion: number | null;
	/** The octo·modern user who started it (from the audit log), else null. */
	startedBy: string | null;
	/** The OctoPrint user that owns the job (the API key's user when octo·modern started it). */
	octoprintUser: string | null;
	/** `live`: recorded as it happened; `import`: backfilled from OctoPrint. */
	source: 'live' | 'import';
	hasThumbnail: boolean;
	notes: string | null;
	/** Filament used, grams (from the spool's or the material's density). */
	filamentG: number | null;
	/** Material of the (first) spool, or the default material it was costed as. */
	material: string | null;
	/** Cost of the filament and of the electricity, in the cost settings' currency; null when unknown. */
	costFilament: number | null;
	costEnergy: number | null;
	/** costFilament + costEnergy (whichever are known). */
	cost: number | null;
}

export interface HistoryFilter {
	printer?: string;
	result?: PrintResult | '';
	/** Inclusive dates, `YYYY-MM-DD` (local to the browser that asked; compared with start time). */
	from?: string;
	to?: string;
	q?: string;
}

export interface PrinterStats {
	printerId: string;
	printerName: string;
	prints: number;
	success: number;
	failed: number;
	cancelled: number;
	/** Seconds. */
	printTime: number;
	filamentMm: number;
	/** Sum of the known print costs. */
	cost: number;
}

export interface WeekStats {
	/** Monday of the week, `YYYY-MM-DD` (UTC). */
	week: string;
	prints: number;
	success: number;
	failed: number;
	cancelled: number;
	printTime: number;
	filamentMm: number;
}

export interface HistoryStats {
	/** Finished prints only (running ones are left out). */
	prints: number;
	success: number;
	failed: number;
	cancelled: number;
	/** success / (success + failed + cancelled), 0–1; null without finished prints. */
	successRate: number | null;
	printTime: number;
	filamentMm: number;
	/** Sum of the known print costs, and how many prints had one. */
	cost: number;
	costed: number;
	/** The cost settings' currency (ISO 4217). */
	currency?: string;
	perPrinter: PrinterStats[];
	perWeek: WeekStats[];
}

// --- timelapse -------------------------------------------------------------------

export type TimelapseType = 'off' | 'zchange' | 'timed';

export interface TimelapseConfig {
	type: TimelapseType;
	/** Frames per second of the rendered video. */
	fps: number | null;
	/** Timed: seconds between snapshots. */
	interval: number | null;
	/** Seconds the last frame is held at the end. */
	postRoll: number | null;
	/** Z-change: retraction Z-hop (mm) to ignore. */
	retractionZHop: number | null;
	/** Z-change: minimum seconds between frames. */
	minDelay: number | null;
}

export interface TimelapseFile {
	name: string;
	bytes: number | null;
	/** Epoch ms. */
	date: number | null;
	/** File name of its thumbnail in the timelapse folder, if OctoPrint made one. */
	thumbnail: string | null;
	/** A container browsers can play (mp4/webm/m4v). */
	playable: boolean;
}

export interface UnrenderedTimelapse {
	name: string;
	bytes: number | null;
	date: number | null;
	/** Frames captured. */
	count: number | null;
	recording: boolean;
	rendering: boolean;
	processing: boolean;
}

export interface TimelapseListing {
	/** OctoPrint can make timelapses (a snapshot URL and ffmpeg are configured). */
	enabled: boolean;
	config: TimelapseConfig;
	files: TimelapseFile[];
	unrendered: UnrenderedTimelapse[];
}
