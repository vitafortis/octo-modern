/**
 * Before a print starts: does the active spool of each tool hold enough filament for
 * the file? Used by the job "start" action, "print this file", and the library's
 * send-and-print. Never blocks a print because Spoolman is unreachable.
 */
import { encodePath, type OctoPrintClient } from '../octoprint/client.ts';
import { listAssignments, toolCount } from './assignments.ts';
import { spoolmanConfigured, spoolsById } from './spoolman.ts';
import { findShortfalls, mmFromGrams, shortfallMessage, type FilamentNeed, type SpoolSummary } from '#lib/spools.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** OctoPrint's analysis `filament` (`{ tool0: { length, volume } }`) → mm per tool number. */
export function perToolMm(filament: unknown): Record<number, number> {
	const out: Record<number, number> = {};
	if (!isObj(filament)) return out;
	for (const [k, v] of Object.entries(filament)) {
		const m = /^tool(\d+)$/.exec(k);
		const len = isObj(v) && typeof v.length === 'number' && Number.isFinite(v.length) ? v.length : null;
		if (m && len != null && len > 0) out[Number(m[1])] = len;
	}
	return out;
}

/** Whether a check is worth an extra request: Spoolman is set up and the printer has a spool. */
export function wantsFilamentCheck(printerId: string): boolean {
	return spoolmanConfigured() && listAssignments(printerId).length > 0;
}

/** Filament per tool from OctoPrint's analysis of a file on the printer; null if unknown. */
export async function needForFile(client: OctoPrintClient, origin: string, path: string): Promise<FilamentNeed | null> {
	try {
		const raw = await client.get<Obj>(`/api/files/${origin === 'sdcard' ? 'sdcard' : 'local'}/${encodePath(path)}`, { timeoutMs: 6_000 });
		const perTool = perToolMm(isObj(raw?.gcodeAnalysis) ? raw.gcodeAnalysis.filament : null);
		return Object.keys(perTool).length ? { perTool } : null;
	} catch {
		return null;
	}
}

/** From slicer metadata (library files): totals only, so it's all on tool 0. */
export function needFromMeta(meta: { filamentMm: number | null; filamentG: number | null }): FilamentNeed | null {
	const mm = meta.filamentMm ?? (meta.filamentG ? mmFromGrams(meta.filamentG, 1.24, 1.75) : null);
	return mm ? { perTool: { 0: mm }, totalG: meta.filamentG } : null;
}

/** The 409 message when a spool won't last, else null. */
export async function filamentWarning(printerId: string, need: FilamentNeed | null): Promise<string | null> {
	if (!need || !spoolmanConfigured()) return null;
	const assignments = listAssignments(printerId);
	if (!assignments.length) return null;
	let byId: Map<number, SpoolSummary>;
	try {
		byId = await spoolsById(assignments.map((a) => a.spoolId));
	} catch (err) {
		console.warn(`[octo-modern] filament check skipped: ${(err as Error).message}`);
		return null;
	}
	const byTool = new Map<number, SpoolSummary>();
	for (const a of assignments) {
		const s = byId.get(a.spoolId);
		if (s) byTool.set(a.tool, s);
	}
	const short = findShortfalls(need, byTool);
	return short.length ? shortfallMessage(short, toolCount(printerId) > 1 || assignments.length > 1) : null;
}
