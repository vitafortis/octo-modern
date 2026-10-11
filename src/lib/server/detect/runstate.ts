/**
 * The failure detector's per-print state, saved (kv `detect:run:<printer id>`) so a
 * restart mid-print carries on with the same score, the alerts already sent, a pause
 * already done and a false-alarm mark, instead of starting afresh. Saved after every
 * frame; discarded when the print ends or a different print is running.
 *
 * Not part of the settings backup (config-backup.ts only takes `detect:settings` and
 * `detect:printer:*`).
 */
import { deleteKv, getKv, setKv } from '../store.ts';
import type { PrintScore } from './score.ts';
import type { DetectEvent, DetectLevel, DetectPoint, DetectStatus } from '#lib/detect.ts';

export interface SavedRun {
	path: string;
	/** The print history entry of the print, when the tracker had one. */
	printId: number | null;
	file: string;
	startedAt: number;
	lastPrintTime: number | null;
	score: PrintScore;
	normalized: number | null;
	level: DetectLevel;
	history: DetectPoint[];
	events: DetectEvent[];
	last: DetectStatus['last'];
	error: string | null;
	dismissed: { by: string; at: number } | null;
	warned: boolean;
	okSince: number | null;
	failureHandled: boolean;
	savedAt: number;
}

const key = (printerId: string) => `detect:run:${printerId}`;

export function loadSavedRun(printerId: string): SavedRun | null {
	const r = getKv<SavedRun | null>(key(printerId), null);
	return r && typeof r.path === 'string' && r.score && typeof r.score.frames === 'number' ? r : null;
}

export function saveRun(printerId: string, run: SavedRun) {
	setKv(key(printerId), run);
}

export function clearSavedRun(printerId: string) {
	deleteKv(key(printerId));
}

/** How far the print's start may seem to move between before and after a restart. */
const START_SLACK_MS = 5 * 60_000;

/**
 * Whether saved state belongs to the print running now: the same file, the same
 * history entry when both are known, else not restarted (print time didn't go
 * back) and started at about the same time.
 */
export function resumable(
	saved: Pick<SavedRun, 'path' | 'printId' | 'startedAt' | 'lastPrintTime'>,
	cur: { path: string; printId: number | null; printTime: number | null; startedAt: number }
): boolean {
	if (saved.path !== cur.path) return false;
	if (saved.printId != null && cur.printId != null) return saved.printId === cur.printId;
	if (cur.printTime != null && saved.lastPrintTime != null && cur.printTime + 60 < saved.lastPrintTime) return false;
	return Math.abs(cur.startedAt - saved.startedAt) <= START_SLACK_MS;
}
