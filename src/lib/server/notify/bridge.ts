/**
 * Connects notifications to what octo·modern sees: the print history's start, pause
 * and end (history/tracker.ts), and every printer's live state, log and events
 * (printers.observe) for progress, offline/error/back, hot-after-print and pause
 * reasons. Started by the `notifications` job.
 */
import { printers } from '../octoprint/manager.ts';
import { history } from '../history/tracker.ts';
import { openPrints } from '../history/store.ts';
import { listPrinters, sqlite } from '../store.ts';
import type { PrintRecord } from '#lib/history.ts';
import type { EventKind } from '#lib/notify.ts';
import type { Printer } from '#lib/types.ts';
import type { LiveEvent } from '../octoprint/model.ts';
import { notify } from './service.ts';
import { load } from './settings.ts';
import type { NotifyEvent, PrintFacts } from './types.ts';
import { PrinterWatch, type WatchConfig } from './watcher.ts';

/** The octo·modern user behind the latest audited `actions` on a printer in a time window. */
export function auditedActor(printerId: string, actions: string[], from: number, to: number): string | null {
	try {
		const row = sqlite()
			.prepare(
				`SELECT a.user_email, u.name FROM audit a LEFT JOIN users u ON u.id = a.user_id
				 WHERE a.printer_id = ? AND a.action IN (${actions.map(() => '?').join(', ')}) AND a.at BETWEEN ? AND ? ORDER BY a.id DESC LIMIT 1`
			)
			.get(printerId, ...actions, new Date(from).toISOString(), new Date(to).toISOString()) as { user_email: string | null; name: string | null } | undefined;
		return row ? (row.name ?? row.user_email ?? 'someone') : null;
	} catch {
		return null;
	}
}

const END_KIND: Record<string, EventKind> = { success: 'print.finished', failed: 'print.failed', cancelled: 'print.cancelled' };

/** The facts of a history entry. */
export function recordFacts(r: PrintRecord): PrintFacts {
	return {
		id: r.id,
		file: r.file,
		path: r.path,
		startedAt: r.startedAt,
		endedAt: r.endedAt,
		elapsedS: r.durationS,
		estimatedS: r.estimatedS,
		completion: r.completion,
		filamentMm: r.filamentMm,
		startedBy: r.startedBy ?? (r.octoprintUser ? `${r.octoprintUser} (OctoPrint)` : null),
		reason: r.reason
	};
}

/** The notification for a finished print (exported for tests and the old module's callers). */
export function endEvent(r: PrintRecord, cancelledBy: string | null = null): NotifyEvent | null {
	const kind = END_KIND[r.result];
	if (!kind) return null;
	return { kind, printerId: r.printerId, printerName: r.printerName, print: { ...recordFacts(r), cancelledBy: kind === 'print.cancelled' ? cancelledBy : null } };
}

const config = (): WatchConfig => {
	const s = load();
	return { progressPercents: s.progressPercents, progressMinutesLeft: s.progressMinutesLeft, offlineGraceS: s.offlineGraceS, hot: s.hot };
};

class NotifyBridge {
	private watches = new Map<string, PrinterWatch>();
	private stop: (() => void) | null = null;
	private cfg: { at: number; value: WatchConfig } | null = null;

	private watch(id: string): PrinterWatch {
		let w = this.watches.get(id);
		if (!w) this.watches.set(id, (w = new PrinterWatch()));
		return w;
	}

	/** Settings, re-read at most every few seconds (updates arrive often). */
	private config(): WatchConfig {
		const now = Date.now();
		if (!this.cfg || now - this.cfg.at > 5_000) this.cfg = { at: now, value: config() };
		return this.cfg.value;
	}

	start() {
		if (this.stop) return;
		const off = printers.observe((id, e) => this.onLive(id, e));
		const onChange = (type: 'start' | 'pause' | 'resume', r: PrintRecord, p: Printer | undefined, at: number) => this.onChange(type, r, p, at);
		const onEnded = (r: PrintRecord) => this.onEnded(r);
		history.changes.add(onChange);
		history.ended.add(onEnded);
		this.stop = () => {
			off();
			history.changes.delete(onChange);
			history.ended.delete(onEnded);
		};
	}

	/** Drops state when settings change (e.g. new milestones) — next update re-reads. */
	invalidate() {
		this.cfg = null;
	}

	private send(events: NotifyEvent[]) {
		for (const ev of events) void notify(ev);
	}

	private onLive(id: string, e: LiveEvent) {
		try {
			const w = this.watch(id);
			const now = Date.now();
			switch (e.type) {
				case 'update': {
					const out = w.observe(e.snapshot, now, this.config());
					this.send(out.map((x) => ({ ...x, printerId: id, print: x.print ? { ...x.print, startedBy: x.print.startedBy ?? openPrints(id)[0]?.startedBy ?? null } : undefined })));
					return;
				}
				case 'log':
					if (!e.reset) w.log(e.lines, now);
					return;
				case 'event':
					w.event(e.name, e.payload, now);
					return;
				case 'plugin':
					w.event(`plugin:${e.plugin}`, e.data, now);
					return;
			}
		} catch (err) {
			console.error('[octo-modern] notifications: watcher failed', err);
		}
	}

	private onChange(type: 'start' | 'pause' | 'resume', r: PrintRecord, _p: Printer | undefined, at: number) {
		const now = Date.now();
		if (type === 'start') {
			// Noticed late (octo·modern was down, or an end we never saw start): not news.
			if (now - at > 5 * 60_000) return;
			this.send([{ kind: 'print.started', printerId: r.printerId, printerName: r.printerName, print: recordFacts(r) }]);
			return;
		}
		if (type !== 'pause') return;
		// Let OctoPrint's event and the last log lines arrive before deciding why.
		setTimeout(() => {
			const w = this.watch(r.printerId);
			const t = Date.now();
			const reason = w.pauseReason(t);
			const by = reason ? null : (auditedActor(r.printerId, ['job.pause'], at - 60_000, t) ?? w.eventUser(['PrintPaused'], t));
			const snap = printers.snapshot(r.printerId);
			this.send([
				{
					kind: 'print.paused',
					printerId: r.printerId,
					printerName: r.printerName,
					dedupeKey: `print:${r.id}:${Math.floor(at / 1000)}`,
					print: { ...recordFacts(r), completion: snap?.progress?.completion ?? r.completion, elapsedS: snap?.progress?.printTime ?? null, remainingS: snap?.progress?.printTimeLeft ?? null, reason, pausedBy: by }
				}
			]);
		}, 2_000).unref?.();
	}

	private onEnded(r: PrintRecord) {
		const w = this.watch(r.printerId);
		const now = Date.now();
		w.printEnded(now, this.config());
		let by: string | null = null;
		if (r.result === 'cancelled') {
			const end = r.endedAt ? Date.parse(r.endedAt) : now;
			const audited = auditedActor(r.printerId, ['job.cancel'], end - 5 * 60_000, now + 1_000);
			const viaOctoPrint = audited ? null : w.eventUser(['PrintCancelled', 'PrintCancelling'], now);
			by = audited ?? (viaOctoPrint ? `${viaOctoPrint} (OctoPrint)` : null);
		}
		const ev = endEvent(r, by);
		if (ev) this.send([ev]);
	}

	/** Runs the timers (offline grace, hot-after-print) for every printer. */
	tick() {
		const cfg = this.config();
		const now = Date.now();
		const list = listPrinters();
		for (const p of list) {
			const w = this.watches.get(p.id);
			if (!w) continue;
			this.send(w.tick(now, cfg).map((x) => ({ ...x, printerId: p.id, printerName: p.name })));
		}
		for (const id of [...this.watches.keys()]) if (!list.some((p) => p.id === id)) this.watches.delete(id);
	}
}

const KEY = Symbol.for('octo-modern.notify-bridge');
type G = typeof globalThis & { [KEY]?: NotifyBridge };
export const bridge: NotifyBridge = ((globalThis as G)[KEY] ??= new NotifyBridge());
