/**
 * The queue dispatcher: starts the next matching job on every printer that is
 * connected, idle, not held, and whose bed someone has confirmed clear.
 *
 * - Every print (queued or not) leaves the bed occupied: the moment a printer is seen
 *   printing, and again when the history tracker reports the print's end, the printer
 *   is marked "awaiting bed clear". Nothing more is sent to it until a user (or a
 *   token, see /api/status/<id>/bed-clear) confirms the bed is clear.
 * - A queued job runs one copy at a time. The end of its print (from the history
 *   tracker, which also gives the history entry it is linked to) counts a copy on
 *   success; failure or cancellation marks the job failed and holds the printer.
 * - State lives in the store (queue_jobs, queue_printers), so a restart picks up where
 *   it left off: running prints are still tracked by the history tracker, and a job
 *   that was being transferred when the app stopped is sorted out on the next tick.
 * - Before a job starts, the same filament check as a manual start (spools/check.ts):
 *   when an active Spoolman spool on the printer holds less than the file needs, the
 *   job is held (status `held`, the reason in its `error`) and a `spool.low`
 *   notification goes out. "Check again" requeues it; "Print anyway" requeues it
 *   with the check skipped for its next start.
 * - Pre-print steps (preprint/service.ts): with leveling or pre-print G-code set up for
 *   the printer, the file is transferred without printing and started through them; the
 *   job stays `starting` while they run, and fails (holding the printer) when they do.
 */
import { printers } from '../octoprint/manager.ts';
import { backendFor } from '../backend/index.ts';
import { canReach } from '#lib/printer-kind.ts';
import { history } from '../history/tracker.ts';
import { openPrints } from '../history/store.ts';
import { notify } from '../notify/index.ts';
import { audit, canControl } from '../permissions.ts';
import { currentState, refreshSoon } from '../control.ts';
import { getPrinter, getUser, listPrinters } from '../store.ts';
import { getSource } from '../library/sources.ts';
import { power } from '../power/service.ts';
import { fileMeta, readMetaFrom, sourceAllowsPrinter, withDriver } from '../library/service.ts';
import { startSend } from '../library/send.ts';
import { prep } from '../preprint/service.ts';
import { prepConfigured } from '../preprint/settings.ts';
import { printerFileSize, stagedPath, stagedSize, uploadFileToPrinter } from './files.ts';
import { filamentOverride, finishRun, getJob, getQueuePrinter, insertRun, isPaused, listJobs, setAwaitingClear, setFilamentOverride, setHeld, transition, type StoredJob, type StoredQueuePrinter } from './store.ts';
import { filamentWarning, needForFile, needFromMeta, wantsFilamentCheck } from '../spools/check.ts';
import type { PrinterBackend } from '../backend/types.ts';
import type { FilamentNeed } from '#lib/spools.ts';
import { open } from 'node:fs/promises';
import { jobActive, type PrinterState } from '#lib/printer.ts';
import { tagsMatch, type QueuePrinter } from '#lib/queue.ts';
import { baseName } from '#lib/library.ts';
import type { PrintRecord } from '#lib/history.ts';
import type { Printer, User } from '#lib/types.ts';

// --- matching (pure) -----------------------------------------------------------------------

export interface PrinterView {
	id: string;
	tags: string[];
	awaitingClear: boolean;
	held: boolean;
	state: PrinterState | undefined;
	hasApiKey: boolean;
	/** A queued job is starting or printing on it. */
	busy: boolean;
	/** The history tracker has an open print on it. */
	tracking: boolean;
}

/** Whether `job` may run on printer `p` at all (target, tags), ignoring readiness. */
export function jobFits(job: Pick<StoredJob, 'printerId' | 'tags'>, p: Pick<PrinterView, 'id' | 'tags'>): boolean {
	if (job.printerId) return job.printerId === p.id;
	return tagsMatch(job.tags, p.tags);
}

/** Whether a printer can take a new job right now. */
export function printerReady(p: PrinterView): boolean {
	return p.hasApiKey && !p.held && !p.awaitingClear && !p.busy && !p.tracking && p.state === 'operational';
}

/**
 * Which job each ready printer should start: per printer (in order), the first queued
 * job that fits it and that `allowed` accepts, each job at most once.
 */
export function planDispatch(
	paused: boolean,
	views: PrinterView[],
	jobs: Pick<StoredJob, 'id' | 'status' | 'printerId' | 'tags'>[],
	allowed: (jobId: string, printerId: string) => boolean = () => true
): { printerId: string; jobId: string }[] {
	if (paused) return [];
	const taken = new Set<string>();
	const plan: { printerId: string; jobId: string }[] = [];
	for (const p of views) {
		if (!printerReady(p)) continue;
		const job = jobs.find((j) => j.status === 'queued' && !taken.has(j.id) && jobFits(j, p) && allowed(j.id, p.id));
		if (!job) continue;
		taken.add(job.id);
		plan.push({ printerId: p.id, jobId: job.id });
	}
	return plan;
}

/** Not talking to OctoPrint's printer: what a printer whose smart plug is off looks like. */
const UNPOWERED: (PrinterState | undefined)[] = ['disconnected', 'error', 'offline', 'unknown', undefined];

/**
 * Printers that would take a job if they were on: everything `printerReady` asks for except
 * the connection (bed confirmed clear, not held or busy), with a queued job that fits.
 * The dispatcher asks smart plugs with auto power-on to switch these on.
 */
export function wantPower(
	paused: boolean,
	views: PrinterView[],
	jobs: Pick<StoredJob, 'id' | 'status' | 'printerId' | 'tags'>[],
	allowed: (jobId: string, printerId: string) => boolean = () => true
): { printerId: string; jobId: string }[] {
	if (paused) return [];
	const out: { printerId: string; jobId: string }[] = [];
	for (const p of views) {
		if (!p.hasApiKey || p.held || p.awaitingClear || p.busy || p.tracking || !UNPOWERED.includes(p.state)) continue;
		const job = jobs.find((j) => j.status === 'queued' && jobFits(j, p) && allowed(j.id, p.id));
		if (job) out.push({ printerId: p.id, jobId: job.id });
	}
	return out;
}

/** Same file? Compares OctoPrint paths, falling back to the base name (the printer may store it elsewhere). */
export function sameFile(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return a.replace(/^\/+/, '') === b.replace(/^\/+/, '') || baseName(a) === baseName(b);
}

// --- the dispatcher ---------------------------------------------------------------------------

const STUCK_MS = 90_000;
/** After a failed auto power-on, wait this long before trying that printer again. */
const POWER_RETRY_MS = 5 * 60_000;
const SEND_TIMEOUT_MS = 60 * 60_000;

type Locals = { user: User | null; ip?: string };


/**
 * A queue event through notify() (with a webcam snapshot, except for filament); tests
 * replace `dispatcher.notify`. `spool.low`: a job was held for lack of filament.
 */
export async function notifyQueueEvent(event: 'queue.bed_clear_needed' | 'spool.low', o: { title: string; message: string; printer: { id: string; name: string } }): Promise<void> {
	const link = event === 'spool.low' ? '/queue' : `/p/${encodeURIComponent(o.printer.id)}?tab=queue`;
	await notify({ kind: event, printerId: o.printer.id, printerName: o.printer.name, title: o.title, message: o.message, link, dedupeKey: o.message, ...(event === 'spool.low' ? { snapshot: false } : {}) });
}

/** Reads a byte range of a local file. */
async function readRange(file: string, start: number, end: number): Promise<Buffer> {
	const fh = await open(file, 'r');
	try {
		const buf = Buffer.alloc(end - start + 1);
		const { bytesRead } = await fh.read(buf, 0, buf.length, start);
		return buf.subarray(0, bytesRead);
	} finally {
		await fh.close();
	}
}

/**
 * Filament a queued job's file needs, from where it lives: OctoPrint's analysis (a
 * printer's own file), the library's slicer metadata, or the uploaded file's header.
 * Null when unknown (then nothing is held).
 */
export async function jobFilamentNeed(job: Pick<StoredJob, 'id' | 'source' | 'sourceId' | 'path'>, backend: PrinterBackend): Promise<FilamentNeed | null> {
	try {
		if (job.source === 'printer') return await needForFile(backend, 'local', job.path);
		if (job.source === 'library') {
			const src = job.sourceId ? getSource(job.sourceId) : undefined;
			return src ? needFromMeta((await fileMeta(src, job.path)).meta) : null;
		}
		const size = await stagedSize(job.id);
		if (!size) return null;
		const file = stagedPath(job.id);
		return needFromMeta((await readMetaFrom((start, end) => readRange(file, start, end), size)).meta);
	} catch {
		return null;
	}
}

class Dispatcher {
	/** Jobs this process is starting right now. */
	private inflight = new Set<string>();
	/** When each printer was last seen idle (while a queued job is "printing" on it). */
	private idleSince = new Map<string, number>();
	/** Last state seen per printer, to notice a print starting. */
	private lastState = new Map<string, PrinterState>();
	/** When someone last confirmed a printer's bed clear. */
	private clearedAt = new Map<string, number>();
	private stopObserving: (() => void) | null = null;
	private ticking: Promise<void> | null = null;
	private kickTimer: ReturnType<typeof setTimeout> | null = null;
	/** Printers being powered on for a queued job, or when that last failed. */
	private powering = new Map<string, number>();
	/** Set by tests to observe notifications. */
	notify: typeof notifyQueueEvent = notifyQueueEvent;

	/** Starts listening to live state and print ends. Idempotent. */
	start() {
		power.keepOnChecks.add(this.keepOnCheck);
		history.start();
		history.ended.add(this.onEnded);
		this.stopObserving ??= printers.observe((id, e) => {
			if (e.type !== 'update') return;
			const prev = this.lastState.get(id);
			const state = e.snapshot.state;
			this.lastState.set(id, state);
			// A print started (from anywhere): the bed won't be clear afterwards.
			if (jobActive(state) && prev !== undefined && !jobActive(prev)) setAwaitingClear(id, true);
			// A printer became idle: maybe it can take a job now.
			if (state === 'operational' && prev !== 'operational') this.kick(1_500);
		});
	}

	/** Runs a tick soon (after a user action or a state change). */
	kick(delay = 250) {
		if (this.kickTimer) return;
		this.kickTimer = setTimeout(() => {
			this.kickTimer = null;
			void this.tick();
		}, delay);
		this.kickTimer.unref?.();
	}

	/** One pass: sort out jobs left over from a restart, then dispatch. Never overlaps itself. */
	tick(): Promise<void> {
		this.ticking ??= this.run().finally(() => (this.ticking = null));
		return this.ticking;
	}

	/** Per-printer views for matching and for the UI. */
	views(jobs: StoredJob[] = listJobs()): (PrinterView & { printer: Printer; q: StoredQueuePrinter })[] {
		return listPrinters().map((printer) => {
			const q = getQueuePrinter(printer.id);
			return {
				printer,
				q,
				id: printer.id,
				tags: q.tags,
				awaitingClear: q.awaitingClear,
				held: q.held,
				state: printers.snapshot(printer.id)?.state,
				// Reachable at all: OctoPrint needs a key, Moonraker may not.
				hasApiKey: canReach(printer),
				// A queued job is starting or printing on it, or it's being prepared for a print (leveling…).
				busy: prep.isPreparing(printer.id) || jobs.some((j) => j.activePrinterId === printer.id && (j.status === 'starting' || j.status === 'printing')),
				tracking: openPrints(printer.id).length > 0
			};
		});
	}

	/** Whether the job's source and creator allow this printer. */
	allowed(job: StoredJob, printerId: string): boolean {
		if (job.source === 'printer' && job.sourceId !== printerId) return false;
		if (job.source === 'library') {
			const src = job.sourceId ? getSource(job.sourceId) : undefined;
			if (!src || !sourceAllowsPrinter(src, printerId)) return false;
		}
		// Jobs added by a user only go to printers that user may control (keys and admins: any).
		if (job.createdById) {
			const u = getUser(job.createdById);
			if (u && !canControl(u, { id: printerId })) return false;
		}
		return true;
	}

	/** The QueuePrinter rows for the UI (with how many jobs each could take). */
	printerStates(jobs: StoredJob[] = listJobs()): QueuePrinter[] {
		return this.views(jobs).map((v) => ({
			...v.q,
			waiting: jobs.filter((j) => j.status === 'queued' && jobFits(j, v) && this.allowed(j, v.id)).length
		}));
	}

	private async run() {
		const jobs = listJobs();
		const views = this.views(jobs);
		const now = Date.now();
		// Jobs "starting" or "printing" that nobody in this process is handling.
		for (const j of jobs) {
			if (this.inflight.has(j.id) || !j.activePrinterId) continue;
			const v = views.find((x) => x.id === j.activePrinterId);
			if (!v) {
				this.fail(j, null, 'The printer was removed');
				continue;
			}
			if (j.status === 'starting') {
				// Left over from a restart mid-transfer.
				const snap = printers.snapshot(v.id);
				if (snap && jobActive(snap.state) && sameFile(snap.job?.file?.path, j.activePath ?? j.path)) {
					transition(j.id, 'starting', { status: 'printing', activePath: snap.job?.file?.path ?? j.activePath });
				} else if (v.state === 'operational' && !v.tracking) {
					finishRun(j.id, { printId: null, result: 'failed', reason: 'interrupted' });
					transition(j.id, 'starting', { status: 'queued', activePrinterId: null, activePath: null, error: 'The transfer was interrupted (octo·modern restarted); it will start again.' });
				}
				continue;
			}
			if (j.status === 'printing') {
				// The end was missed (or the print never began): idle for a while with nothing tracked.
				if (v.state === 'operational' && !v.tracking) {
					const since = this.idleSince.get(v.id) ?? now;
					this.idleSince.set(v.id, since);
					if (now - since > STUCK_MS) this.fail(j, v.printer, 'The print didn’t start, or octo·modern lost track of it');
				} else this.idleSince.delete(v.id);
			}
		}
		const allowedFn = (jobId: string, printerId: string) => this.allowed(jobs.find((j) => j.id === jobId)!, printerId);
		// Smart plugs with auto power-on: switch on printers that have a job waiting and a clear bed.
		for (const { printerId, jobId } of wantPower(isPaused(), views, jobs, allowedFn)) {
			if (!power.autoOnEnabled(printerId)) continue;
			const last = this.powering.get(printerId);
			if (last !== undefined && (last === 0 || now - last < POWER_RETRY_MS)) continue;
			this.powering.set(printerId, 0);
			const job = jobs.find((j) => j.id === jobId)!;
			void power.ensurePrinterOn(printerId, { reason: `queued job ${job.name}` }).then((r) => {
				if (r.ready) {
					this.powering.delete(printerId);
					this.kick(500);
				} else this.powering.set(printerId, Date.now());
			});
		}
		const plan = planDispatch(isPaused(), views, jobs, allowedFn);
		for (const { printerId, jobId } of plan) {
			const v = views.find((x) => x.id === printerId)!;
			const job = jobs.find((j) => j.id === jobId)!;
			// Start in the background: a transfer can take minutes.
			void this.startJob(job, v.printer);
		}
	}

	/** Marks a job failed and holds the printer it was on. */
	private fail(job: StoredJob, printer: Printer | null, reason: string) {
		finishRun(job.id, { printId: null, result: 'failed', reason });
		transition(job.id, ['starting', 'printing'], { status: 'failed', activePrinterId: null, activePath: null, error: reason });
		if (printer) {
			setHeld(printer.id, true, `${job.name}: ${reason}`);
			audit({ user: null }, 'queue.fail', { printer, detail: `${job.name}: ${reason}` });
		}
	}

	/** Transfers (if needed) and starts a job on a printer. */
	async startJob(job: StoredJob, printer: Printer): Promise<void> {
		if (this.inflight.has(job.id)) return;
		if (!transition(job.id, 'queued', { status: 'starting', activePrinterId: printer.id, activePath: null, error: null })) return;
		this.inflight.add(job.id);
		this.idleSince.delete(printer.id);
		const creator = job.createdById ? (getUser(job.createdById) ?? null) : null;
		const locals: Locals = { user: creator };
		const copy = `${job.done + 1}/${job.copies}`;
		try {
			const backend = backendFor(printer);
			const state = await currentState(printer.id, backend);
			if (state !== 'operational') {
				transition(job.id, 'starting', { status: 'queued', activePrinterId: null });
				return;
			}
			// The same filament check as starting a print by hand; "Print anyway" skips it once.
			if (!filamentOverride(job.id) && wantsFilamentCheck(printer.id)) {
				const warning = await filamentWarning(printer.id, await jobFilamentNeed(job, backend));
				if (warning) {
					await this.holdForFilament(job, printer, warning);
					return;
				}
			}
			insertRun(job.id, printer);
			// Pre-print steps set up for the printer: transfer without printing, then start through them.
			const viaPrep = prepConfigured(printer);
			let path: string;
			/** The transfer itself started the print (no pre-print steps). */
			let started = false;
			if (job.source === 'printer') {
				path = job.path;
			} else if (job.source === 'library') {
				const src = job.sourceId ? getSource(job.sourceId) : undefined;
				if (!src) throw new Error('The library source was removed');
				const name = baseName(job.path);
				const [have, st] = await Promise.all([printerFileSize(backend, name), withDriver(src, (d) => d.stat(job.path))]);
				if (have != null && have === st.size) {
					// Already on the printer (an earlier copy): just print it.
					path = name;
				} else {
					const send = await startSend(locals, { src, path: job.path, printer, backend, folder: '', print: !viaPrep });
					const began = Date.now();
					while (!send.finishedAt && Date.now() - began < SEND_TIMEOUT_MS) await new Promise((r) => setTimeout(r, 500));
					if (send.state !== 'done') throw new Error(send.error ?? 'The transfer didn’t finish');
					if (!viaPrep && !send.printing) throw new Error('Sent, but the printer wasn’t ready to print');
					path = send.storedPath ?? name;
					started = !viaPrep;
				}
			} else {
				const file = stagedPath(job.id);
				const size = await stagedSize(job.id);
				if (size == null) throw new Error('The uploaded file is gone');
				const have = await printerFileSize(backend, job.name);
				if (have != null && have === size) {
					path = job.name;
				} else {
					const r = await uploadFileToPrinter(backend, { file, name: job.name, print: !viaPrep, select: viaPrep });
					if (!viaPrep && !r.printing) throw new Error('Uploaded, but the printer wasn’t ready to print');
					path = r.path;
					started = !viaPrep;
					if (started) audit(locals, 'job.start', { printer, detail: path });
				}
			}
			if (!started) {
				// Waits for leveling and the pre-print G-code, when they run first.
				const r = await prep.begin({ printer, backend, origin: 'local', path, how: 'select', locals, via: 'queue' });
				await r.done;
			}
			transition(job.id, 'starting', { status: 'printing', activePath: path });
			setFilamentOverride(job.id, false);
			audit(locals, 'queue.start', { printer, detail: `${job.name} (copy ${copy})` });
			refreshSoon(printer.id);
		} catch (err) {
			const msg = (err as Error).message || String(err);
			const hint = (err as { hint?: string }).hint;
			this.fail(getJob(job.id) ?? job, printer, `Couldn’t start: ${msg}${hint ? `. ${hint}` : ''}`);
		} finally {
			this.inflight.delete(job.id);
		}
	}

	/** Keeps a job back because the printer's spool won't last it, and says so. */
	private async holdForFilament(job: StoredJob, printer: Printer, question: string) {
		// The check's message asks "Start anyway?"; here nobody is there to answer.
		const warning = question.replace(/\s*Start anyway\?$/, '');
		const reason = `Not enough filament on ${printer.name}: ${warning}`;
		if (!transition(job.id, 'starting', { status: 'held', activePrinterId: null, activePath: null, error: reason })) return;
		audit({ user: null }, 'queue.hold', { printer, detail: `${job.name}: ${reason}`.slice(0, 480) });
		await this.notify('spool.low', {
			title: `Queue held: not enough filament on ${printer.name}`,
			message: `${job.name} wasn’t started on ${printer.name}. ${warning} Load a fuller spool and choose “Check again”, or “Print anyway” in the queue.`,
			printer: { id: printer.id, name: printer.name }
		}).catch(() => {});
	}

	/** A print ended (history tracker): count or fail the queued job, and ask for the bed to be cleared. */
	readonly onEnded = async (record: PrintRecord, printer: Printer | undefined) => {
		const id = record.printerId;
		const endedAt = record.endedAt ? Date.parse(record.endedAt) : Date.now();
		// Someone may have confirmed the bed while the end was being settled.
		if ((this.clearedAt.get(id) ?? 0) < endedAt) setAwaitingClear(id, true);
		this.idleSince.delete(id);
		const job = listJobs().find((j) => j.activePrinterId === id && (j.status === 'printing' || j.status === 'starting'));
		if (job && (job.status === 'printing' ? sameFile(record.path, job.activePath ?? job.path) : sameFile(record.path, job.source === 'upload' ? job.name : job.path))) {
			const result = record.result === 'success' ? 'success' : record.result === 'cancelled' ? 'cancelled' : 'failed';
			finishRun(job.id, { printId: record.id, result, reason: record.reason });
			if (result === 'success') {
				const done = job.done + 1;
				const finished = done >= job.copies;
				transition(job.id, ['printing', 'starting'], { status: finished ? 'done' : 'queued', done, activePrinterId: null, activePath: null, finishedAt: finished ? new Date().toISOString() : null });
			} else {
				const reason = result === 'cancelled' ? 'Cancelled' : `Failed${record.reason ? ` (${record.reason})` : ''}`;
				transition(job.id, ['printing', 'starting'], { status: 'failed', activePrinterId: null, activePath: null, error: reason });
				setHeld(id, true, `${job.name}: ${reason.toLowerCase()}`);
			}
		}
		const p = printer ?? getPrinter(id);
		if (!p || isPaused() || !getQueuePrinter(id).awaitingClear) return;
		const jobs = listJobs();
		const waiting = jobs.filter((j) => j.status === 'queued' && jobFits(j, { id, tags: getQueuePrinter(id).tags }) && this.allowed(j, id));
		if (!waiting.length) return;
		await this.notify('queue.bed_clear_needed', {
			title: `Clear the bed: ${p.name}`,
			message: `${p.name} finished ${record.file} (${record.result}). ${waiting.length} queued job${waiting.length === 1 ? '' : 's'} wait${waiting.length === 1 ? 's' : ''} for it; next: ${waiting[0].name}. Confirm the bed is clear in octo·modern to continue.`,
			printer: { id: p.id, name: p.name }
		}).catch(() => {});
	};

	/** Holds back a due auto power-off while queued jobs wait for this printer's bed to be cleared. */
	readonly keepOnCheck = (printerId: string): string | null => {
		const q = getQueuePrinter(printerId);
		if (!q.awaitingClear || q.held || isPaused()) return null;
		const n = listJobs().filter((j) => j.status === 'queued' && jobFits(j, { id: printerId, tags: q.tags }) && this.allowed(j, printerId)).length;
		return n ? `${n} queued job${n === 1 ? '' : 's'} wait${n === 1 ? 's' : ''} for the bed to be cleared` : null;
	};

	/** Someone confirmed the bed is clear. */
	bedCleared(printerId: string) {
		this.clearedAt.set(printerId, Date.now());
		setAwaitingClear(printerId, false);
		this.kick();
	}
}

const KEY = Symbol.for('octo-modern.queue-dispatcher');
type G = typeof globalThis & { [KEY]?: Dispatcher };

/** The process-wide dispatcher (survives dev-server module reloads). */
export const dispatcher: Dispatcher = ((globalThis as G)[KEY] ??= new Dispatcher());
