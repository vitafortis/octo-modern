/**
 * The print queue, shared by the server and the browser. Pure: no I/O.
 *
 * Jobs wait in one ordered list. Each targets a specific printer, or "any compatible
 * printer": one whose free-form tags include every tag the job requires (e.g. `0.4mm`,
 * `PETG`, `bed:300`). A printer takes the next matching job when it's connected and idle,
 * and someone has confirmed its bed is clear.
 */

export type QueueSourceKind = 'library' | 'printer' | 'upload';

/** `held`: kept back (not enough filament on the printer that would take it); see `error`. */
export type QueueJobStatus = 'queued' | 'starting' | 'printing' | 'held' | 'failed' | 'done';

export interface QueueRun {
	id: number;
	printerId: string;
	printerName: string;
	/** The print history entry of this run, once the tracker has one. */
	printId: number | null;
	result: 'printing' | 'success' | 'failed' | 'cancelled';
	reason: string | null;
	startedAt: string;
	endedAt: string | null;
}

export interface QueueJob {
	id: string;
	/** Display name (the file name). */
	name: string;
	source: QueueSourceKind;
	/** Library source id (library) or printer id (printer); null for uploads. */
	sourceId: string | null;
	/** Library source name, for display. */
	sourceName: string | null;
	/** Path in the library, or on the printer (printer). */
	path: string;
	size: number | null;
	/** The printer it must print on; null = any compatible printer. */
	printerId: string | null;
	/** Tags a printer needs to take this job (only for "any printer"). */
	tags: string[];
	copies: number;
	/** Copies printed successfully so far. */
	done: number;
	status: QueueJobStatus;
	/** The printer running it now (starting/printing). */
	activePrinterId: string | null;
	error: string | null;
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	runs: QueueRun[];
}

/** Per-printer queue state. */
export interface QueuePrinter {
	printerId: string;
	tags: string[];
	/** A print ended (or nobody has confirmed yet): someone must say the bed is clear. */
	awaitingClear: boolean;
	awaitingSince: string | null;
	/** Dispatch to this printer is paused (after a failed or cancelled queued print, or by hand). */
	held: boolean;
	heldReason: string | null;
	/** Queued jobs this printer could take next. */
	waiting: number;
}

export interface QueueState {
	paused: boolean;
	jobs: QueueJob[];
	printers: QueuePrinter[];
}

/** Where a slicer upload key sends files (see octoprint-compat.ts). */
export type UploadTarget =
	| { kind: 'library'; sourceId: string; folder: string }
	| { kind: 'queue'; printerId: string | null; tags: string[] }
	| { kind: 'printer'; printerId: string; allowPrint: boolean };

export const MAX_TAGS = 20;
export const MAX_COPIES = 100;

/** Normalized tags: trimmed, lower-cased, no duplicates, at most MAX_TAGS of 1–32 characters. */
export function parseTags(raw: unknown): string[] {
	const list = typeof raw === 'string' ? raw.split(/[,\s]+/) : Array.isArray(raw) ? raw : [];
	const out: string[] = [];
	for (const t of list) {
		if (typeof t !== 'string') continue;
		const tag = t.trim().toLowerCase().slice(0, 32);
		if (tag && /^[\p{L}\p{N}._:+#/-]+$/u.test(tag) && !out.includes(tag)) out.push(tag);
		if (out.length >= MAX_TAGS) break;
	}
	return out;
}

/** Whether a printer with `printerTags` may take a job that requires `required`. */
export function tagsMatch(required: string[], printerTags: string[]): boolean {
	return required.every((t) => printerTags.includes(t));
}

export function clampCopies(raw: unknown): number {
	const n = Math.round(Number(raw));
	return Number.isFinite(n) ? Math.min(MAX_COPIES, Math.max(1, n)) : 1;
}

export const STATUS_LABEL: Record<QueueJobStatus, string> = {
	queued: 'Queued',
	starting: 'Starting',
	printing: 'Printing',
	held: 'Held',
	failed: 'Failed',
	done: 'Done'
};

/** Whether the job still has copies to print. */
export const isPending = (j: Pick<QueueJob, 'status'>) => j.status === 'queued' || j.status === 'starting' || j.status === 'printing' || j.status === 'held';
