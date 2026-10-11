/**
 * Watches one printer's live state for the notifications the print history doesn't
 * produce: progress milestones, offline / error / back, still hot after a print, and
 * why a print paused (from the terminal log and OctoPrint's events). Pure: the caller
 * feeds it snapshots, log lines and events with timestamps, and sends what it returns.
 */
import type { EventKind } from '#lib/notify.ts';
import type { PrinterState } from '#lib/printer.ts';
import type { PrintFacts } from './types.ts';

export interface WatchConfig {
	progressPercents: number[];
	progressMinutesLeft: number[];
	offlineGraceS: number;
	hot: { minutes: number; bedC: number; hotendC: number };
}

/** The parts of a live snapshot the watcher reads. */
export interface WatchSnapshot {
	state: PrinterState;
	printerError?: string | null;
	problem?: { message: string } | null;
	job?: { file?: { path?: string; name?: string; display?: string } | null; estimatedPrintTime?: number | null } | null;
	progress?: { completion: number | null; printTime: number | null; printTimeLeft: number | null } | null;
	temps?: Record<string, { actual: number | null; target: number | null }>;
}

export interface WatchEvent {
	kind: EventKind;
	message?: string;
	title?: string;
	print?: PrintFacts;
	dedupeKey?: string;
	fields?: { label: string; value: string }[];
}

type Class = 'up' | 'down' | 'error';

function classify(s: PrinterState): Class | null {
	if (s === 'offline' || s === 'disconnected') return 'down';
	if (s === 'error') return 'error';
	if (s === 'unknown' || s === 'connecting') return null;
	return 'up';
}

const PRINTING = new Set<PrinterState>(['printing', 'finishing', 'resuming']);
const ACTIVE = new Set<PrinterState>(['printing', 'pausing', 'paused', 'resuming', 'finishing', 'cancelling']);
const LOOKBACK_MS = 90_000;

/** Why a print paused, from what the printer and OctoPrint said just before. Exported for tests. */
export function pauseReasonFrom(lines: string[], events: { name: string; payload: unknown }[]): string | null {
	for (const e of events) {
		if (e.name === 'FilamentChange') {
			const cmd = e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>).cmd : null;
			return `filament change (${typeof cmd === 'string' && cmd ? cmd : 'M600'})`;
		}
		if (/runout/i.test(e.name) || (e.name.startsWith('plugin:') && /runout|no.?filament/i.test(JSON.stringify(e.payload ?? '')))) return 'filament runout';
	}
	for (const l of [...lines].reverse()) {
		if (/^Recv:.*(runout|filament (out|ran out)|out of filament|no filament)/i.test(l)) return 'filament runout';
		if (/^Send:\s*(N\d+\s+)?M600\b/i.test(l)) return 'filament change (M600)';
		const m = /^Send:\s*(?:N\d+\s+)?(M0|M1|M25|M125|M601)\b/i.exec(l);
		if (m) return `pause in the G-code (${m[1].toUpperCase()})`;
		if (/@pause\b/i.test(l)) return 'pause in the G-code (@pause)';
		if (/^Recv:.*\/\/\s*action:\s*pause/i.test(l)) return 'paused by the printer';
	}
	return null;
}

export class PrinterWatch {
	private cls: Class | null = null;
	private downSince: number | null = null;
	private notified: 'offline' | 'error' | null = null;
	private lastProblem: string | null = null;
	/** The print the milestones belong to. */
	private printKey: string | null = null;
	private lastCompletion: number | null = null;
	private lastLeft: number | null = null;
	private fired = new Set<string>();
	private hotAt: number | null = null;
	private hotEndedAt: number | null = null;
	private lines: { at: number; line: string }[] = [];
	private events: { at: number; name: string; payload: unknown }[] = [];
	private snap: WatchSnapshot | null = null;

	/** A new snapshot: progress milestones and state changes. */
	observe(s: WatchSnapshot, now: number, cfg: WatchConfig): WatchEvent[] {
		this.snap = s;
		const out: WatchEvent[] = [];
		this.progress(s, out, cfg);
		const c = classify(s.state);
		if (c && c !== this.cls) {
			const first = this.cls === null;
			this.cls = c;
			if (c === 'down') {
				this.lastProblem = s.state === 'offline' ? (s.problem?.message ?? 'OctoPrint is unreachable') : 'The printer is disconnected from OctoPrint';
				// A printer already down when we first see it (e.g. octo·modern restarted) doesn't count.
				this.downSince = first ? null : now;
			} else if (c === 'error') {
				this.downSince = null;
				if (!first && this.notified !== 'error') {
					this.notified = 'error';
					out.push({ kind: 'printer.error', message: s.printerError ? `Printer error: ${s.printerError}` : undefined, fields: s.printerError ? [{ label: 'Error', value: s.printerError }] : [] });
				}
			} else {
				this.downSince = null;
				if (this.notified) {
					this.notified = null;
					out.push({ kind: 'printer.online' });
				}
			}
		}
		out.push(...this.tick(now, cfg));
		return out;
	}

	/** Timers: the offline grace period and the hot-after-print check. */
	tick(now: number, cfg: WatchConfig): WatchEvent[] {
		const out: WatchEvent[] = [];
		if (this.cls === 'down' && this.downSince != null && now - this.downSince >= cfg.offlineGraceS * 1000 && this.notified !== 'offline') {
			this.notified = 'offline';
			const mins = Math.round((now - this.downSince) / 60_000);
			out.push({ kind: 'printer.offline', message: `${this.lastProblem ?? 'Offline'}${mins >= 1 ? ` (for ${mins} min)` : ''}.`, fields: this.lastProblem ? [{ label: 'Problem', value: this.lastProblem }] : [] });
		}
		if (this.hotAt != null && now >= this.hotAt) {
			this.hotAt = null;
			const s = this.snap;
			if (s && this.cls === 'up' && !ACTIVE.has(s.state)) {
				const temps = s.temps ?? {};
				const bed = temps.bed?.actual ?? null;
				const tools = Object.entries(temps).filter(([k, v]) => /^tool\d+$/.test(k) && v.actual != null) as [string, { actual: number }][];
				const hotTools = tools.filter(([, v]) => v.actual >= cfg.hot.hotendC);
				const bedHot = bed != null && bed >= cfg.hot.bedC;
				if (bedHot || hotTools.length) {
					const parts = [bedHot ? `bed ${Math.round(bed!)} °C` : null, ...hotTools.map(([k, v]) => `${tools.length > 1 ? k : 'hotend'} ${Math.round(v.actual)} °C`)].filter(Boolean);
					const mins = this.hotEndedAt != null ? Math.round((now - this.hotEndedAt) / 60_000) : cfg.hot.minutes;
					out.push({
						kind: 'printer.hot',
						message: `Still hot ${mins} min after the print: ${parts.join(', ')}.`,
						dedupeKey: `hot:${this.hotEndedAt ?? now}`,
						fields: [
							...(bed != null ? [{ label: 'Bed', value: `${Math.round(bed)} °C (threshold ${cfg.hot.bedC} °C)` }] : []),
							...tools.map(([k, v]) => ({ label: tools.length > 1 ? k : 'Hotend', value: `${Math.round(v.actual)} °C (threshold ${cfg.hot.hotendC} °C)` }))
						]
					});
				}
			}
		}
		return out;
	}

	private progress(s: WatchSnapshot, out: WatchEvent[], cfg: WatchConfig) {
		const path = s.job?.file?.path ?? s.job?.file?.name ?? null;
		if (!ACTIVE.has(s.state) || !path) {
			if (!ACTIVE.has(s.state)) this.printKey = null;
			return;
		}
		const completion = s.progress?.completion ?? null;
		const left = s.progress?.printTimeLeft ?? null;
		if (this.printKey !== path) {
			// First sight of this print: nothing fires for what already happened.
			this.printKey = path;
			this.fired.clear();
			this.lastCompletion = completion;
			this.lastLeft = left;
			return;
		}
		if (!PRINTING.has(s.state)) return;
		const facts = (): PrintFacts => ({
			file: s.job?.file?.display ?? s.job?.file?.name ?? path,
			path,
			completion,
			elapsedS: s.progress?.printTime ?? null,
			remainingS: left,
			estimatedS: s.job?.estimatedPrintTime ?? null
		});
		if (completion != null && this.lastCompletion != null) {
			const crossed = cfg.progressPercents.filter((p) => this.lastCompletion! < p && completion >= p && !this.fired.has(`p${p}`));
			for (const p of crossed) this.fired.add(`p${p}`);
			if (crossed.length) {
				const p = Math.max(...crossed);
				out.push({ kind: 'print.progress', print: facts(), dedupeKey: `${path}:p${p}`, title: `${p}% done: ${facts().file}` });
			}
		}
		if (left != null && left > 0 && this.lastLeft != null && (completion == null || completion < 100)) {
			const crossed = cfg.progressMinutesLeft.filter((m) => this.lastLeft! > m * 60 && left <= m * 60 && !this.fired.has(`m${m}`));
			for (const m of crossed) this.fired.add(`m${m}`);
			if (crossed.length) {
				const m = Math.min(...crossed);
				out.push({ kind: 'print.progress', print: facts(), dedupeKey: `${path}:m${m}`, title: `${m} min left: ${facts().file}` });
			}
		}
		if (completion != null) this.lastCompletion = completion;
		if (left != null) this.lastLeft = left;
	}

	/** Terminal lines (`Send: …` / `Recv: …`), kept briefly for pause reasons. */
	log(lines: string[], now: number) {
		for (const line of lines) if (/^(Send|Recv):/.test(line) || /@pause/i.test(line)) this.lines.push({ at: now, line });
		this.trim(now);
	}

	/** OctoPrint events and plugin messages (`plugin:<name>`). */
	event(name: string, payload: unknown, now: number) {
		this.events.push({ at: now, name, payload });
		this.trim(now);
	}

	private trim(now: number) {
		this.lines = this.lines.filter((l) => now - l.at < LOOKBACK_MS).slice(-200);
		this.events = this.events.filter((e) => now - e.at < 5 * 60_000).slice(-100);
	}

	pauseReason(now: number): string | null {
		const lines = this.lines.filter((l) => now - l.at < LOOKBACK_MS).map((l) => l.line);
		const events = this.events.filter((e) => now - e.at < LOOKBACK_MS);
		return pauseReasonFrom(lines, events);
	}

	/** The OctoPrint user an event names (`user`), e.g. who cancelled or paused through OctoPrint. */
	eventUser(names: string[], now: number, withinMs = 5 * 60_000): string | null {
		for (const e of [...this.events].reverse()) {
			if (now - e.at > withinMs || !names.includes(e.name)) continue;
			const u = e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>).user : null;
			if (typeof u === 'string' && u && u !== '_api') return u;
		}
		return null;
	}

	/** A print ended: check the temperatures `hot.minutes` later. */
	printEnded(now: number, cfg: WatchConfig) {
		this.hotEndedAt = now;
		this.hotAt = now + cfg.hot.minutes * 60_000;
		this.printKey = null;
	}
}
