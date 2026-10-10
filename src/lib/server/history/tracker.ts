/**
 * Records every print, whether or not anyone is watching.
 *
 * How prints are noticed when nobody has a printer open: the manager polls every
 * printer nobody watches (`OCM_POLL_INTERVAL_MS`, 10 s), and every poll result passes
 * through `printers.observe`, like push updates do. The detector sees the state turn
 * "Printing" and opens a history entry. From then until the print ends, the tracker
 * holds the printer "watched" (`printers.watch`), which keeps OctoPrint's push socket
 * open for it: one websocket per printing printer, so the end arrives as OctoPrint's
 * own PrintDone / PrintFailed / PrintCancelled event, with the exact result and print
 * time, the moment it happens. If the push socket can't connect, the manager polls
 * every 2 s instead, and the detector infers the end from the state change, then
 * settles the outcome from the file's last-print statistics.
 *
 * So polling alone covers every print longer than one poll interval, and the push
 * socket makes the result exact while a print runs, without keeping a socket open to
 * idle printers.
 */
import { printers, clientFor } from '../octoprint/manager.ts';
import { encodePath } from '../octoprint/client.ts';
import { safeThumbnail } from '../octoprint/files.ts';
import { getPrinter } from '../store.ts';
import { PrintDetector, type ActiveJob, type HistoryAction } from './detector.ts';
import { auditedStarter, getPrint, insertPrint, lastEnded, openPrints, setThumbnail, updatePrint } from './store.ts';
import { captureThumbnail } from './thumbnail.ts';
import type { LiveEvent } from '../octoprint/model.ts';
import type { PrintRecord } from '#lib/history.ts';
import type { JobInfo } from '#lib/printer.ts';
import type { Printer } from '#lib/types.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (ms: number) => new Date(ms).toISOString();

/** Filament of a job's analysis, mm summed over tools. */
export function analysisFilament(job: Pick<JobInfo, 'filament'> | null | undefined): number | null {
	if (!job?.filament) return null;
	let mm: number | null = null;
	for (const f of Object.values(job.filament)) if (f.length != null) mm = (mm ?? 0) + f.length;
	return mm;
}

export interface FileInfo {
	filamentMm: number | null;
	estimatedS: number | null;
	thumbnail: string | null;
	/** OctoPrint's record of the file's last print (epoch ms). */
	last: { date: number; success: boolean; printTime: number | null } | null;
}

/** The parts of an OctoPrint file entry the history uses. */
export function parseFileInfo(raw: unknown): FileInfo {
	const r = isObj(raw) ? raw : {};
	const analysis = isObj(r.gcodeAnalysis) ? r.gcodeAnalysis : null;
	let filamentMm: number | null = null;
	if (analysis && isObj(analysis.filament)) {
		for (const f of Object.values(analysis.filament)) {
			const len = isObj(f) ? num(f.length) : null;
			if (len != null) filamentMm = (filamentMm ?? 0) + len;
		}
	}
	const prints = isObj(r.prints) ? r.prints : null;
	const l = prints && isObj(prints.last) ? prints.last : null;
	const date = l ? num(l.date) : null;
	return {
		filamentMm,
		estimatedS: analysis ? num(analysis.estimatedPrintTime) : null,
		thumbnail: safeThumbnail(r.thumbnail),
		last: l && date != null && typeof l.success === 'boolean' ? { date: date * 1000, success: l.success, printTime: num(l.printTime) } : null
	};
}

async function fileInfo(printer: Printer, origin: string, path: string): Promise<FileInfo | null> {
	try {
		const raw = await clientFor(printer).get<unknown>(`/api/files/${origin === 'sdcard' ? 'sdcard' : 'local'}/${encodePath(path)}`, { timeoutMs: 6_000 });
		return parseFileInfo(raw);
	} catch {
		return null;
	}
}

/** Called with each finished print (after its outcome is settled), e.g. for notifications. */
export type EndedListener = (record: PrintRecord, printer: Printer | undefined) => void | Promise<void>;

class HistoryTracker {
	private detectors = new Map<string, PrintDetector>();
	/** The open history row per printer. */
	private rows = new Map<string, number>();
	/** Releases the push connection held while a printer prints. */
	private holds = new Map<string, () => void>();
	private chains = new Map<string, Promise<void>>();
	private stop: (() => void) | null = null;
	readonly ended = new Set<EndedListener>();

	/** Starts listening to every printer's live state. Idempotent. */
	start() {
		this.stop ??= printers.observe((id, e) => this.onLive(id, e));
	}

	/** Resolves once every queued history write has finished (for tests). */
	async idle(): Promise<void> {
		await Promise.all([...this.chains.values()]);
	}

	private hold(id: string) {
		if (!this.holds.has(id)) this.holds.set(id, printers.watch(id));
	}

	private release(id: string) {
		this.holds.get(id)?.();
		this.holds.delete(id);
	}

	/** The detector of a printer, resuming a print that was running when the app last stopped. */
	private detector(id: string): PrintDetector {
		let d = this.detectors.get(id);
		if (d) return d;
		let restore: ActiveJob | null = null;
		const [latest, ...stale] = openPrints(id);
		for (const s of stale) updatePrint(s.id, { result: 'failed', reason: 'lost track' });
		if (latest) {
			restore = {
				file: { name: latest.path.split('/').pop() ?? latest.file, display: latest.file, path: latest.path, origin: latest.origin },
				startedAt: Date.parse(latest.startedAt),
				printTime: null,
				completion: latest.completion,
				paused: latest.result === 'paused',
				cancelling: false
			};
			this.rows.set(id, latest.id);
			this.hold(id);
		}
		d = new PrintDetector(restore);
		this.detectors.set(id, d);
		return d;
	}

	/** Fills in who started a print, from the audit log, if it isn't known yet. */
	private attribute(rowId: number) {
		try {
			const r = getPrint(rowId);
			if (!r || r.startedBy || r.source !== 'live') return;
			const who = auditedStarter(r.printerId, Date.parse(r.startedAt), [r.path.split('/').pop() ?? r.file, r.file]);
			if (who) updatePrint(rowId, { userId: who.userId, startedBy: who.label });
		} catch (err) {
			console.error('[octo-modern] print history: attribution failed', err);
		}
	}

	private onLive(id: string, e: LiveEvent) {
		if (e.type !== 'update' && e.type !== 'event') return;
		let actions: HistoryAction[] = [];
		try {
			const d = this.detector(id);
			actions =
				e.type === 'update'
					? d.observe({ at: Date.now(), state: e.snapshot.state, job: e.snapshot.job, progress: e.snapshot.progress })
					: d.event(e.name, e.payload, Date.now());
		} catch (err) {
			console.error('[octo-modern] print history: detector failed', err);
		}
		for (const a of actions) {
			const next = (this.chains.get(id) ?? Promise.resolve()).then(() => this.apply(id, a)).catch((err) => console.error('[octo-modern] print history write failed', err));
			this.chains.set(id, next);
			void next.then(() => {
				if (this.chains.get(id) === next) this.chains.delete(id);
			});
		}
	}

	private async apply(id: string, a: HistoryAction) {
		const printer = getPrinter(id);
		switch (a.type) {
			case 'start': {
				if (!printer) return;
				// The job's analysis: from the action (poll/push update) or the live snapshot.
				const snapJob = printers.snapshot(id)?.job;
				const job = a.job ?? (snapJob?.file?.path === a.file.path ? snapJob : null);
				const who = auditedStarter(id, a.startedAt, [a.file.name, a.file.display]);
				const rowId = insertPrint({
					printerId: id,
					printerName: printer.name,
					file: a.file.display,
					path: a.file.path,
					origin: a.file.origin,
					startedAt: iso(a.startedAt),
					result: 'printing',
					// While printing this holds the analysis total; the end scales it by how far the print got.
					filamentMm: analysisFilament(job),
					estimatedS: job?.estimatedPrintTime ?? null,
					completion: 0,
					userId: who?.userId ?? null,
					startedBy: who?.label ?? null,
					octoprintUser: a.user ?? job?.user ?? null
				});
				if (rowId != null) {
					this.rows.set(id, rowId);
					// The route that started it writes its audit entry after OctoPrint answers,
					// which can be after OctoPrint's PrintStarted event: look again shortly.
					if (!who) setTimeout(() => this.attribute(rowId), 3_000).unref?.();
				}
				this.hold(id);
				return;
			}
			case 'pause':
			case 'resume': {
				const rowId = this.rows.get(id);
				if (rowId != null) updatePrint(rowId, { result: a.type === 'pause' ? 'paused' : 'printing' });
				return;
			}
			case 'end': {
				const rowId = this.rows.get(id);
				this.rows.delete(id);
				this.release(id);
				if (rowId != null) this.attribute(rowId);
				const row = rowId != null ? getPrint(rowId) : undefined;
				const info = printer ? await fileInfo(printer, a.file.origin, a.file.path) : null;
				// OctoPrint's own record of this print, if it's the one that just ended.
				const last = info?.last && info.last.date >= a.startedAt - 5_000 && info.last.date <= Date.now() + 5_000 ? info.last : null;
				let result = a.result;
				let endedAt = a.endedAt;
				let printTime = a.printTime;
				if (!result) result = last ? (last.success ? 'success' : 'cancelled') : 'cancelled';
				if (last && a.via === 'observe') {
					// A poll noticed the end late; OctoPrint knows exactly when it was.
					endedAt = Math.min(endedAt, last.date);
					if (last.success && last.printTime != null) printTime = last.printTime;
				}
				const durationS = printTime != null && printTime > 0 ? printTime : Math.max(0, (endedAt - a.startedAt) / 1000);
				const completion = result === 'success' ? 100 : a.completion;
				const total = info?.filamentMm ?? row?.filamentMm ?? null;
				const filamentMm = total == null ? null : result === 'success' ? total : completion != null ? (total * Math.max(0, Math.min(100, completion))) / 100 : null;
				const patch = {
					endedAt: iso(endedAt),
					durationS,
					result,
					reason: a.reason,
					completion,
					filamentMm,
					estimatedS: row?.estimatedS ?? info?.estimatedS ?? null
				};
				let finalId = rowId;
				if (row) updatePrint(row.id, patch);
				else if (printer) {
					// Never saw the start (e.g. the row was deleted meanwhile): record it whole.
					finalId =
						insertPrint({ printerId: id, printerName: printer.name, file: a.file.display, path: a.file.path, origin: a.file.origin, startedAt: iso(a.startedAt), ...patch }) ?? undefined;
				}
				if (finalId == null) return;
				if (printer) {
					const thumb = await captureThumbnail(printer, info?.thumbnail ?? null);
					if (thumb) setThumbnail(finalId, thumb.data, thumb.type);
				}
				const record = getPrint(finalId);
				if (record) for (const fn of this.ended) await Promise.resolve(fn(record, printer)).catch((err) => console.error('[octo-modern] print-ended listener failed', err));
				return;
			}
			case 'amend': {
				const row = lastEnded(id, a.file.path, a.file.origin, iso(a.endedAt - 2 * 60_000));
				if (!row) return;
				const patch: Parameters<typeof updatePrint>[1] = { result: a.result, reason: a.reason };
				if (a.printTime != null && a.printTime > 0) patch.durationS = a.printTime;
				if (a.result === 'success') patch.completion = 100;
				updatePrint(row.id, patch);
				return;
			}
		}
	}
}

const KEY = Symbol.for('octo-modern.history-tracker');
type G = typeof globalThis & { [KEY]?: HistoryTracker };

/** The process-wide tracker (survives dev-server module reloads). */
export const history: HistoryTracker = ((globalThis as G)[KEY] ??= new HistoryTracker());
