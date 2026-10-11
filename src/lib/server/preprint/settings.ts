/**
 * Pre-print settings in the kv table: `preprint:settings` (the global default, admins)
 * and `preprint:printer:<id>` (per printer). Both are in config backups (Settings).
 */
import { deleteKv, getKv, setKv, sqlite } from '../store.ts';
import {
	BED_TEMP,
	MAX_GCODE,
	PREP_DEFAULTS,
	PRINTER_DEFAULTS,
	TIMEOUT_MIN,
	patternError,
	resolvePrep,
	type MatchMode,
	type PrepGlobal,
	type PrepMode,
	type PrepPrinter,
	type ResolvedPrep
} from '#lib/preprint.ts';
import type { PrinterKind } from '#lib/types.ts';

export const GLOBAL_KEY = 'preprint:settings';
export const printerKey = (id: string) => `preprint:printer:${id}`;
export const isPrepKey = (key: string) => key === GLOBAL_KEY || key.startsWith('preprint:printer:');

export class SettingsError extends Error {}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function text(v: unknown, fallback: string, label: string, max = MAX_GCODE): string {
	if (v === undefined || v === null) return fallback;
	if (typeof v !== 'string') throw new SettingsError(`${label} must be text`);
	const s = v.replace(/\r\n/g, '\n');
	if (s.length > max) throw new SettingsError(`${label} is too long (at most ${max} characters)`);
	return s;
}

function pattern(v: unknown, fallback: string, label: string): string {
	const s = text(v, fallback, label, 400).trim();
	const err = patternError(s);
	if (err) throw new SettingsError(`${label}: ${err}`);
	return s;
}

function num(v: unknown, fallback: number, range: { min: number; max: number }, label: string): number {
	if (v === undefined || v === null || v === '') return fallback;
	const n = Number(v);
	if (!Number.isFinite(n) || n < range.min || n > range.max) throw new SettingsError(`${label} must be between ${range.min} and ${range.max}`);
	return Math.round(n);
}

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const match = (v: unknown, fallback: MatchMode): MatchMode => (v === 'exact' || v === 'commands' ? v : fallback);
const mode = (v: unknown, fallback: PrepMode): PrepMode => (v === 'default' || v === 'custom' || v === 'none' ? v : fallback);

/** Validates (and fills in) global settings; throws SettingsError with a message for people. */
export function parseGlobal(raw: unknown, base: PrepGlobal = PREP_DEFAULTS): PrepGlobal {
	const r = obj(raw);
	const sn = obj(r.snippet);
	const lv = obj(r.leveling);
	return {
		snippet: {
			enabled: bool(sn.enabled, base.snippet.enabled),
			gcode: text(sn.gcode, base.snippet.gcode, 'The pre-print G-code'),
			match: match(sn.match, base.snippet.match),
			skipPattern: pattern(sn.skipPattern, base.snippet.skipPattern, 'The snippet’s skip pattern')
		},
		leveling: {
			enabled: bool(lv.enabled, base.leveling.enabled),
			octoprintCommand: text(lv.octoprintCommand, base.leveling.octoprintCommand, 'The leveling command (OctoPrint)', 2000),
			klipperCommand: text(lv.klipperCommand, base.leveling.klipperCommand, 'The leveling command (Klipper)', 2000),
			skipPattern: pattern(lv.skipPattern, base.leveling.skipPattern, 'The leveling skip pattern'),
			heatBed: bool(lv.heatBed, base.leveling.heatBed),
			bedTemp: num(lv.bedTemp, base.leveling.bedTemp, BED_TEMP, 'The bed temperature for leveling')
		},
		timeoutMin: num(r.timeoutMin, base.timeoutMin, TIMEOUT_MIN, 'The timeout (minutes)')
	};
}

export function parsePrinter(raw: unknown, base: PrepPrinter = PRINTER_DEFAULTS): PrepPrinter {
	const r = obj(raw);
	const sn = obj(r.snippet);
	const lv = obj(r.leveling);
	return {
		snippet: {
			mode: mode(sn.mode, base.snippet.mode),
			gcode: text(sn.gcode, base.snippet.gcode, 'The pre-print G-code'),
			match: match(sn.match, base.snippet.match),
			skipPattern: pattern(sn.skipPattern, base.snippet.skipPattern, 'The snippet’s skip pattern')
		},
		leveling: {
			mode: mode(lv.mode, base.leveling.mode),
			command: text(lv.command, base.leveling.command, 'The leveling command', 2000),
			skipPattern: pattern(lv.skipPattern, base.leveling.skipPattern, 'The leveling skip pattern'),
			heatBed: bool(lv.heatBed, base.leveling.heatBed),
			bedTemp: num(lv.bedTemp, base.leveling.bedTemp, BED_TEMP, 'The bed temperature for leveling')
		}
	};
}

/** Stored values, repaired: a damaged row falls back to the defaults rather than break printing. */
function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

export function loadGlobal(): PrepGlobal {
	return safe(() => parseGlobal(getKv<unknown>(GLOBAL_KEY, null)), PREP_DEFAULTS);
}

export function saveGlobal(input: unknown): PrepGlobal {
	const next = parseGlobal(input, loadGlobal());
	setKv(GLOBAL_KEY, next);
	return next;
}

export function loadPrinter(id: string): PrepPrinter {
	return safe(() => parsePrinter(getKv<unknown>(printerKey(id), null)), PRINTER_DEFAULTS);
}

export function savePrinter(id: string, input: unknown): PrepPrinter {
	const next = parsePrinter(input, loadPrinter(id));
	if (next.snippet.mode === 'default' && next.leveling.mode === 'default' && !next.snippet.gcode && !next.leveling.command) deleteKv(printerKey(id));
	else setKv(printerKey(id), next);
	return next;
}

export function forgetPrinter(id: string) {
	deleteKv(printerKey(id));
}

/** What applies to a printer now. */
export function resolvedFor(printer: { id: string; kind: PrinterKind }): ResolvedPrep {
	return resolvePrep(loadGlobal(), loadPrinter(printer.id), printer.kind);
}

/** Leveling or a snippet is on for this printer (the file decides whether they run). */
export function prepConfigured(printer: { id: string; kind: PrinterKind }): boolean {
	const r = resolvedFor(printer);
	return !!(r.leveling || r.snippet);
}

// --- backups ------------------------------------------------------------------------------

/** Every pre-print row, for a config backup. */
export function exportPrep(): Record<string, unknown> {
	const rows: Record<string, unknown> = {};
	for (const r of sqlite().prepare(`SELECT key, value FROM kv WHERE key LIKE 'preprint:%' ORDER BY key`).all() as { key: string; value: string }[]) {
		if (isPrepKey(r.key)) rows[r.key] = JSON.parse(r.value);
	}
	return rows;
}

/** Replaces the pre-print settings (inside the restore's transaction). Invalid rows are skipped. */
export function importPrep(rows: Record<string, unknown>) {
	for (const r of sqlite().prepare(`SELECT key FROM kv WHERE key LIKE 'preprint:%'`).all() as { key: string }[]) if (isPrepKey(r.key)) deleteKv(r.key);
	for (const [key, value] of Object.entries(rows ?? {})) {
		if (!isPrepKey(key)) continue;
		try {
			setKv(key, key === GLOBAL_KEY ? parseGlobal(value) : parsePrinter(value));
		} catch {
			// A row this version can't read: leave the default.
		}
	}
}
