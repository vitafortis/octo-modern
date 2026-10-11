/**
 * Running auto power-off countdowns, persisted (kv `power:auto-off:<printer id>`) so a
 * restart mid-countdown resumes it instead of leaving the printer on for good. The
 * service writes a row when a countdown arms and removes it when it is cancelled or
 * the plug was switched off; on startup it picks the rows up again (see
 * `PowerService.runtime`), and a resumed countdown re-checks its conditions (printer
 * idle, hotend cool, plug on) before anything is switched off.
 */
import { deleteKv, getKv, setKv, sqlite } from '../store.ts';
import type { PlugKind } from '#lib/power.ts';

export interface PendingAutoOff {
	printerId: string;
	/** The plug it was armed for (a different kind of plug drops the countdown). */
	plugKind: PlugKind;
	plugLabel: string | null;
	/** Epoch ms the print ended (the countdown started). */
	armedAt: number;
	/** Epoch ms the idle time is up (with the settings it was armed with). */
	offAt: number;
	idleMinutes: number;
	/** Waits for every hotend to be below this (°C). */
	hotendC: number;
	/** Held back while queued jobs wait for the bed to be cleared. */
	waitForQueue: boolean;
	savedAt: number;
}

const PREFIX = 'power:auto-off:';

export function loadPending(printerId: string): PendingAutoOff | null {
	const p = getKv<PendingAutoOff | null>(PREFIX + printerId, null);
	return p && typeof p.armedAt === 'number' && Number.isFinite(p.armedAt) ? p : null;
}

export function savePending(p: PendingAutoOff) {
	setKv(PREFIX + p.printerId, p);
}

export function clearPending(printerId: string) {
	deleteKv(PREFIX + printerId);
}

/** Printer ids with a saved countdown. */
export function pendingPrinterIds(): string[] {
	return (sqlite().prepare(`SELECT key FROM kv WHERE key LIKE 'power:auto-off:%'`).all() as { key: string }[]).map((r) => r.key.slice(PREFIX.length));
}
