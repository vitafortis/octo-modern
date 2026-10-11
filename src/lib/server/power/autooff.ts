/**
 * Auto power-off after a print, as a pure state machine (tested without timers):
 *
 * - a print ending (the state leaves printing/paused/…) arms the countdown;
 * - once the idle time since then is up AND every hotend is below the cool-down
 *   temperature, it fires (the service disconnects OctoPrint and switches the plug off);
 * - a new print, "Keep on", the plug going off by other means, or the feature being
 *   turned off cancels it.
 */
import { jobActive, type PrinterState, type TempReading } from '#lib/printer.ts';
import type { AutoOffCountdown, AutoOffSettings } from '#lib/power.ts';

export interface AutoOffObservation {
	now: number;
	state: PrinterState;
	/** Hottest hotend (°C), null when unknown (e.g. disconnected). */
	hotendC: number | null;
	/** The plug's last known state. */
	plugOn: boolean | null;
	/** Why it mustn't go off yet even when due (e.g. queued jobs wait for the bed); null: nothing. */
	holdReason?: string | null;
}

export type AutoOffEvent = { type: 'armed' } | { type: 'cancelled'; reason: string } | { type: 'fire' } | null;

/** Hottest hotend in a snapshot's temperatures. */
export function maxHotend(temps: Record<string, TempReading>): number | null {
	let max: number | null = null;
	for (const [k, t] of Object.entries(temps)) if (k.startsWith('tool') && t.actual != null) max = max == null ? t.actual : Math.max(max, t.actual);
	return max;
}

/** States that say nothing about whether a print is running (keep the previous one). */
const UNCERTAIN: PrinterState[] = ['unknown', 'offline'];

export class AutoOff {
	/** Epoch ms the countdown started; null while not armed. */
	armedAt: number | null = null;
	private prev: PrinterState | null = null;
	private lastHotend: number | null = null;
	private heldBy: string | null = null;

	observe(o: AutoOffObservation, s: AutoOffSettings): AutoOffEvent {
		const prev = this.prev;
		if (!UNCERTAIN.includes(o.state)) this.prev = o.state;
		this.lastHotend = o.hotendC;
		if (this.armedAt != null) {
			if (!s.enabled) return this.cancel('Auto power-off was turned off');
			if (jobActive(o.state)) return this.cancel('A new print started');
			if (o.plugOn === false) return this.cancel('The plug is off');
			const idleDone = o.now - this.armedAt >= s.idleMinutes * 60_000;
			const cool = o.hotendC == null || o.hotendC < s.hotendC;
			this.heldBy = idleDone && cool ? (o.holdReason ?? null) : null;
			if (idleDone && cool && !this.heldBy) {
				this.armedAt = null;
				return { type: 'fire' };
			}
			return null;
		}
		if (s.enabled && prev && jobActive(prev) && !jobActive(o.state) && !UNCERTAIN.includes(o.state) && o.plugOn !== false) {
			this.armedAt = o.now;
			return { type: 'armed' };
		}
		return null;
	}

	cancel(reason: string): AutoOffEvent {
		if (this.armedAt == null) return null;
		this.armedAt = null;
		this.heldBy = null;
		return { type: 'cancelled', reason };
	}

	countdown(s: AutoOffSettings): AutoOffCountdown | null {
		if (this.armedAt == null) return null;
		const offAt = this.armedAt + s.idleMinutes * 60_000;
		return { since: this.armedAt, offAt, hotendC: this.lastHotend, targetC: s.hotendC, cooling: this.lastHotend != null && this.lastHotend >= s.hotendC, heldBy: this.heldBy };
	}
}
