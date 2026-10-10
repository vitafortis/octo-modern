/**
 * Turns what we see of one printer into print-history actions: a print started,
 * paused, resumed, ended (and how). Pure, so tests can feed it recorded states.
 *
 * Two inputs, either of which is enough on its own:
 * - `observe()`: state snapshots, from the REST poll (every printer, all the time) or
 *   the push socket. A job counts as started when the state turns active (printing,
 *   paused…) and as ended when it turns ready, error or disconnected again. The
 *   outcome is inferred: 100 % done is a success; error or disconnected is a failure;
 *   a "Cancelling" state seen in between is a cancel; anything else is left `null`
 *   for the caller to settle from OctoPrint's file statistics.
 * - `event()`: OctoPrint's events over the push socket (PrintStarted, PrintDone,
 *   PrintFailed, PrintCancelled, PrintPaused, PrintResumed), which are exact.
 *
 * When both report the same end, the first one wins and a later, more exact event
 * `amend`s it (an event's result and print time beat an inference). "Unreachable"
 * (OctoPrint itself down) never ends a print: the print may well go on.
 */
import type { JobInfo, PrinterState, Progress } from '#lib/printer.ts';

export type EndResult = 'success' | 'failed' | 'cancelled';

export interface FileRef {
	name: string;
	display: string;
	path: string;
	origin: string;
}

/** The job in progress, as the detector tracks it (also what the caller persists and restores). */
export interface ActiveJob {
	file: FileRef;
	/** Epoch ms. */
	startedAt: number;
	printTime: number | null;
	completion: number | null;
	paused: boolean;
	cancelling: boolean;
}

export type HistoryAction =
	| { type: 'start'; file: FileRef; startedAt: number; job: JobInfo | null; user: string | null; via: 'event' | 'observe' }
	| { type: 'pause' | 'resume'; file: FileRef; at: number }
	| {
			type: 'end';
			file: FileRef;
			startedAt: number;
			endedAt: number;
			/** null: couldn't tell (the caller settles it, e.g. from the file's last-print stats). */
			result: EndResult | null;
			/** Seconds, OctoPrint's print time when known. */
			printTime: number | null;
			completion: number | null;
			reason: string | null;
			via: 'event' | 'observe';
	  }
	/** A more exact account of a print that already ended. */
	| { type: 'amend'; file: FileRef; endedAt: number; result: EndResult; printTime: number | null; reason: string | null };

export interface Observation {
	at: number;
	state: PrinterState;
	job: JobInfo | null;
	progress: Progress | null;
}

const ACTIVE = new Set<PrinterState>(['printing', 'pausing', 'paused', 'resuming', 'finishing', 'cancelling']);
const IDLE = new Set<PrinterState>(['operational', 'error', 'disconnected']);
/** An end event this long after the end we recorded still refers to that print. */
const SAME_END_MS = 90_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const samePrint = (a: FileRef, b: FileRef) => a.path === b.path && (a.origin || 'local') === (b.origin || 'local');

export function fileFromJob(job: JobInfo | null): FileRef | null {
	const f = job?.file;
	if (!f?.path && !f?.name) return null;
	return { name: f.name, display: f.display || f.name, path: f.path || f.name, origin: f.origin || 'local' };
}

/** `{ name, path, origin }` of an OctoPrint print event. */
export function fileFromPayload(payload: unknown): FileRef | null {
	if (!isObj(payload)) return null;
	const path = str(payload.path) ?? str(payload.name);
	const name = str(payload.name) ?? path?.split('/').pop() ?? null;
	if (!path || !name) return null;
	const origin = str(payload.origin) ?? 'local';
	return { name, display: str(payload.display) ?? name, path, origin };
}

export class PrintDetector {
	active: ActiveJob | null;
	private lastEnd: { file: FileRef; at: number; via: 'event' | 'observe'; result: EndResult | null } | null = null;

	constructor(restore: ActiveJob | null = null) {
		this.active = restore ? { ...restore } : null;
	}

	observe(o: Observation): HistoryAction[] {
		const out: HistoryAction[] = [];
		if (ACTIVE.has(o.state)) {
			const file = fileFromJob(o.job);
			if (!file) return out;
			if (this.active && !samePrint(this.active.file, file)) out.push(this.end(o.at, null, null, null, 'observe'));
			if (!this.active) {
				// The tail of a print we already closed from an event (OctoPrint still says
				// "Cancelling"/"Finishing" for a moment): not a new print.
				const tail = this.lastEnd && samePrint(this.lastEnd.file, file) && o.at - this.lastEnd.at < 15_000 && (o.state === 'cancelling' || o.state === 'finishing');
				if (tail) return out;
				const elapsed = o.progress?.printTime;
				const startedAt = elapsed != null && elapsed > 0 ? o.at - elapsed * 1000 : o.at;
				this.active = { file, startedAt, printTime: elapsed ?? null, completion: o.progress?.completion ?? null, paused: false, cancelling: false };
				out.push({ type: 'start', file, startedAt, job: o.job, user: o.job?.user ?? null, via: 'observe' });
			}
			const a = this.active!;
			if (o.progress?.printTime != null) a.printTime = o.progress.printTime;
			if (o.progress?.completion != null) a.completion = o.progress.completion;
			if (o.state === 'cancelling') a.cancelling = true;
			const paused = o.state === 'paused' || o.state === 'pausing';
			if (paused !== a.paused && o.state !== 'cancelling') {
				a.paused = paused;
				out.push({ type: paused ? 'pause' : 'resume', file: a.file, at: o.at });
			}
			return out;
		}
		if (IDLE.has(o.state) && this.active) {
			const a = this.active;
			const done = (o.progress?.completion ?? 0) >= 100 && (!fileFromJob(o.job) || samePrint(fileFromJob(o.job)!, a.file));
			let result: EndResult | null = null;
			let reason: string | null = null;
			if (done) result = 'success';
			else if (o.state === 'error' || o.state === 'disconnected') {
				result = 'failed';
				reason = o.state === 'error' ? 'error' : 'disconnected';
			} else if (a.cancelling) result = 'cancelled';
			const printTime = done ? (o.progress?.printTime ?? a.printTime) : a.printTime;
			if (done) a.completion = 100;
			out.push(this.end(o.at, result, printTime, reason, 'observe'));
		}
		return out;
	}

	event(name: string, payload: unknown, at: number): HistoryAction[] {
		const out: HistoryAction[] = [];
		const file = fileFromPayload(payload);
		const p = isObj(payload) ? payload : {};
		switch (name) {
			case 'PrintStarted': {
				if (!file) return out;
				if (this.active && samePrint(this.active.file, file) && at - this.active.startedAt < 60_000) return out;
				if (this.active) out.push(this.end(at, null, null, null, 'event'));
				this.active = { file, startedAt: at, printTime: 0, completion: 0, paused: false, cancelling: false };
				out.push({ type: 'start', file, startedAt: at, job: null, user: str(p.user) ?? str(p.owner), via: 'event' });
				return out;
			}
			case 'PrintPaused':
			case 'PrintResumed': {
				if (!this.active || (file && !samePrint(this.active.file, file))) return out;
				const paused = name === 'PrintPaused';
				if (this.active.paused === paused) return out;
				this.active.paused = paused;
				out.push({ type: paused ? 'pause' : 'resume', file: this.active.file, at });
				return out;
			}
			case 'PrintCancelling':
				if (this.active) this.active.cancelling = true;
				return out;
			case 'PrintDone':
			case 'PrintFailed':
			case 'PrintCancelled': {
				const reason = str(p.reason);
				const result: EndResult = name === 'PrintDone' ? 'success' : name === 'PrintCancelled' || reason === 'cancelled' ? 'cancelled' : 'failed';
				const printTime = num(p.time);
				const failReason = result === 'failed' ? (reason ?? 'error') : null;
				if (this.active && (!file || samePrint(this.active.file, file))) {
					if (result === 'success') this.active.completion = 100;
					out.push(this.end(at, result, printTime, failReason, 'event'));
					return out;
				}
				if (!file) return out;
				const last = this.lastEnd;
				if (last && samePrint(last.file, file) && at - last.at < SAME_END_MS) {
					// The same print, already closed: an event is more exact than an inference,
					// and a failure reason beats a plain cancel (OctoPrint sends both on cancel).
					const better = last.via === 'observe' || (last.result !== result && result === 'failed');
					if (better) {
						last.via = 'event';
						last.result = result;
						out.push({ type: 'amend', file: last.file, endedAt: last.at, result, printTime, reason: failReason });
					}
					return out;
				}
				// An end we never saw start (e.g. a short print between two polls): record both.
				const startedAt = printTime != null ? at - printTime * 1000 : at;
				out.push({ type: 'start', file, startedAt, job: null, user: str(p.user) ?? str(p.owner), via: 'event' });
				this.active = { file, startedAt, printTime, completion: result === 'success' ? 100 : null, paused: false, cancelling: false };
				out.push(this.end(at, result, printTime, failReason, 'event'));
				return out;
			}
			default:
				return out;
		}
	}

	private end(at: number, result: EndResult | null, printTime: number | null, reason: string | null, via: 'event' | 'observe'): HistoryAction {
		const a = this.active!;
		this.active = null;
		this.lastEnd = { file: a.file, at, via: result ? via : 'observe', result };
		return {
			type: 'end',
			file: a.file,
			startedAt: a.startedAt,
			endedAt: at,
			result,
			printTime: printTime ?? a.printTime,
			completion: a.completion,
			reason,
			via
		};
	}
}
