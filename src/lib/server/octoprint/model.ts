/**
 * The in-memory picture of one printer: latest state, a rolling temperature history
 * and recent terminal lines. Fed by push messages or REST polls; tells listeners what
 * changed. No I/O, so tests can drive it with recorded messages.
 */
import { emptySnapshot, type LiveSnapshot, type TempSample } from '#lib/printer.ts';
import { TempHistory } from '#lib/temp-history.ts';
import type { OctoPrintError } from './errors.ts';
import { parseJobResponse, parsePrinterResponse, parsePushUpdate, sampleFromReadings } from './parse.ts';

export type LiveEvent =
	/** The snapshot changed; `samples` are new temperature points (may be empty). */
	| { type: 'update'; snapshot: LiveSnapshot; samples: TempSample[] }
	/** The temperature history was rebuilt (e.g. OctoPrint's backlog after connecting). */
	| { type: 'history'; samples: TempSample[] }
	/** New terminal lines (OctoPrint's serial log, "Send: …" / "Recv: …"); `reset` replaces the backlog. */
	| { type: 'log'; lines: string[]; reset?: boolean }
	/** An OctoPrint event (PrintStarted, FileAdded, Connected, …). */
	| { type: 'event'; name: string; payload: unknown }
	/** A plugin's push message, passed through. */
	| { type: 'plugin'; plugin: string; data: unknown };

export type LiveListener = (e: LiveEvent) => void;

const MAX_LOG_LINES = 500;

export class LiveModel {
	readonly id: string;
	readonly history: TempHistory;
	snapshot: LiveSnapshot;
	logs: string[] = [];
	/** Files OctoPrint is printing or otherwise using (can't be deleted). */
	busyFiles: { origin: string; path: string }[] = [];
	private listeners = new Set<LiveListener>();

	constructor(id: string, historyMinutes = 30) {
		this.id = id;
		this.snapshot = emptySnapshot(id);
		// Push sends a sample per update (0.5–2 s); room for 30 min at 2 Hz.
		this.history = new TempHistory(historyMinutes * 60_000, historyMinutes * 60 * 2 + 60);
	}

	on(fn: LiveListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	off(fn: LiveListener) {
		this.listeners.delete(fn);
	}

	/** Removes and returns every listener (they move to a replacement model). */
	takeListeners(): LiveListener[] {
		const all = [...this.listeners];
		this.listeners.clear();
		return all;
	}

	get listenerCount() {
		return this.listeners.size;
	}

	private emit(e: LiveEvent) {
		for (const fn of this.listeners) {
			try {
				fn(e);
			} catch (err) {
				console.error('[octo-modern] live listener failed', err);
			}
		}
	}

	private commit(next: Partial<LiveSnapshot>, samples: TempSample[], now: number) {
		this.snapshot = { ...this.snapshot, ...next, updatedAt: now };
		this.emit({ type: 'update', snapshot: this.snapshot, samples });
	}

	private appendLogs(lines: string[]) {
		if (!lines.length) return;
		this.logs.push(...lines);
		if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
		this.emit({ type: 'log', lines });
	}

	/**
	 * Applies one message from OctoPrint's push socket: `connected`, `current`,
	 * `history`, `event`, `plugin` (others, like `timelapse` or `slicingProgress`,
	 * pass through as events). Returns the message type it handled.
	 */
	applyPush(message: unknown, now = Date.now()): string | null {
		if (!message || typeof message !== 'object') return null;
		const [type, body] = Object.entries(message as Record<string, unknown>)[0] ?? [];
		if (!type) return null;
		switch (type) {
			case 'connected': {
				const b = (body ?? {}) as { version?: unknown; display_version?: unknown };
				const version = typeof b.display_version === 'string' ? b.display_version : typeof b.version === 'string' ? b.version : null;
				if (version && version !== this.snapshot.version) this.snapshot = { ...this.snapshot, version };
				return type;
			}
			case 'current':
			case 'history': {
				const u = parsePushUpdate(body);
				if (!u) return null;
				const next: Partial<LiveSnapshot> = { source: 'push', problem: null, job: u.job, progress: u.progress, currentZ: u.currentZ };
				if (u.state) Object.assign(next, u.state);
				const newest = u.samples.at(-1);
				if (newest) next.temps = Object.fromEntries(Object.entries(newest.v).map(([k, [actual, target]]) => [k, { actual, target }]));
				this.busyFiles = u.busyFiles;
				let added: TempSample[] = [];
				if (type === 'history') {
					this.history.merge(u.samples);
					this.emit({ type: 'history', samples: this.history.toArray() });
				} else {
					added = u.samples.filter((s) => this.history.push(s));
				}
				this.commit(next, added, now);
				if (type === 'history') {
					// The backlog replaces what we had: OctoPrint's buffer is the complete recent log.
					this.logs = u.logs.slice(-MAX_LOG_LINES);
					this.emit({ type: 'log', lines: this.logs, reset: true });
				} else {
					this.appendLogs(u.logs);
				}
				return type;
			}
			case 'event': {
				const b = (body ?? {}) as { type?: unknown; payload?: unknown };
				const name = typeof b.type === 'string' ? b.type : 'Unknown';
				this.emit({ type: 'event', name, payload: b.payload ?? null });
				return type;
			}
			case 'plugin': {
				const b = (body ?? {}) as { plugin?: unknown; data?: unknown };
				this.emit({ type: 'plugin', plugin: typeof b.plugin === 'string' ? b.plugin : 'unknown', data: b.data ?? null });
				return type;
			}
			case 'reauthRequired':
				return type;
			default:
				this.emit({ type: 'event', name: `push:${type}`, payload: body ?? null });
				return type;
		}
	}

	/** Applies a REST poll: /api/printer (null while disconnected) and /api/job. */
	applyPoll(poll: { printer: unknown | null; job: unknown; version?: string | null }, now = Date.now()) {
		const job = parseJobResponse(poll.job);
		const printer = poll.printer ? parsePrinterResponse(poll.printer) : null;
		const state = printer?.state ?? job.state;
		const next: Partial<LiveSnapshot> = { source: 'poll', problem: null, job: job.job, progress: job.progress };
		if (state) Object.assign(next, state);
		if (!poll.printer && state?.state !== 'error') {
			// OctoPrint answers, but no printer is connected (it says "Offline" / "Closed").
			Object.assign(next, { state: state?.state === 'connecting' ? 'connecting' : 'disconnected' });
		}
		if (poll.version) next.version = poll.version;
		next.temps = printer?.temps ?? {};
		let added: TempSample[] = [];
		if (printer && Object.keys(printer.temps).length) {
			const sample = sampleFromReadings(printer.temps, now);
			if (this.history.push(sample)) added = [sample];
		}
		this.commit(next, added, now);
	}

	/** OctoPrint can't be reached: keep the last job info, but mark it offline. */
	setProblem(err: Pick<OctoPrintError, 'message' | 'hint' | 'code'>, now = Date.now()) {
		const problem = { message: err.message, hint: err.hint, code: err.code };
		const same = JSON.stringify(problem) === JSON.stringify(this.snapshot.problem) && this.snapshot.state === 'offline';
		if (same) return;
		this.commit({ state: 'offline', stateText: 'Unreachable', problem, temps: {}, source: this.snapshot.source }, [], now);
	}
}
