/**
 * Before each print: optional bed leveling and a pre-print G-code snippet, run by
 * octo·modern ahead of the file when the file doesn't already do it. Shared by the
 * server (src/lib/server/preprint/) and the browser (settings, the start confirmation).
 * Pure: no I/O.
 *
 * - Settings: a global default (admins, Settings) and a per-printer choice of
 *   "Use the default" / "Custom for this printer" / "None", for the snippet and for
 *   leveling separately. Everything is off by default.
 * - Detection reads the start of the file (up to the first layer change) and compares
 *   commands with comments, line numbers, checksums, case and spacing normalized.
 * - Order: heat the bed (optional, only before leveling), level, the snippet, the file.
 */
import type { PrinterKind } from './types.ts';

export type PrepMode = 'default' | 'custom' | 'none';
/** `exact`: commands with their parameters; `commands`: only the command words (G29, START_PRINT…). */
export type MatchMode = 'exact' | 'commands';

export interface SnippetSettings {
	gcode: string;
	match: MatchMode;
	/** Also skip when a line of the file matches this (plain text, or /regex/flags). */
	skipPattern: string;
}

export interface LevelingSettings {
	command: string;
	/** Also counts as "the file levels the bed" (plain text, or /regex/flags). */
	skipPattern: string;
	/** Heat the bed first (to the file's first bed temperature, else `bedTemp`). */
	heatBed: boolean;
	bedTemp: number;
}

export interface PrepGlobal {
	snippet: SnippetSettings & { enabled: boolean };
	leveling: Omit<LevelingSettings, 'command'> & { enabled: boolean; octoprintCommand: string; klipperCommand: string };
	/** How long one step may take before the start is given up, minutes. */
	timeoutMin: number;
}

export interface PrepPrinter {
	snippet: SnippetSettings & { mode: PrepMode };
	leveling: LevelingSettings & { mode: PrepMode };
}

export interface ResolvedPrep {
	snippet: (SnippetSettings & { source: 'default' | 'custom' }) | null;
	leveling: (LevelingSettings & { source: 'default' | 'custom' }) | null;
	timeoutMs: number;
}

export type StepKind = 'heat' | 'level' | 'snippet';

export interface PrepStep {
	kind: StepKind;
	label: string;
	/** Runs before the file (false: the file does it already). */
	run: boolean;
	/** Why it runs or not, for people. */
	reason: string;
	commands: string[];
}

export interface PrepPlan {
	/** Leveling or the snippet is on for this printer. */
	configured: boolean;
	steps: PrepStep[];
	/** Whether the start of the file could be read (SD card files and errors can't). */
	headRead: boolean;
}

/** What the printer shows while octo·modern prepares it (LiveSnapshot.preparing). */
export interface Preparing {
	id: string;
	file: string;
	step: StepKind | 'checking' | 'starting';
	label: string;
	startedAt: number;
	by: string | null;
}

export const DEFAULT_LEVEL_COMMAND: Record<PrinterKind, string> = {
	octoprint: 'G28\nG29',
	moonraker: 'G28\nBED_MESH_CALIBRATE'
};

export const TIMEOUT_MIN = { min: 1, max: 240, default: 30 };
export const BED_TEMP = { min: 30, max: 130, default: 60 };
export const MAX_GCODE = 10_000;
export const MAX_PATTERN = 200;

export const PREP_DEFAULTS: PrepGlobal = {
	snippet: { enabled: false, gcode: '', match: 'exact', skipPattern: '' },
	leveling: { enabled: false, octoprintCommand: DEFAULT_LEVEL_COMMAND.octoprint, klipperCommand: DEFAULT_LEVEL_COMMAND.moonraker, skipPattern: '', heatBed: false, bedTemp: BED_TEMP.default },
	timeoutMin: TIMEOUT_MIN.default
};

export const PRINTER_DEFAULTS: PrepPrinter = {
	snippet: { mode: 'default', gcode: '', match: 'exact', skipPattern: '' },
	leveling: { mode: 'default', command: '', skipPattern: '', heatBed: false, bedTemp: BED_TEMP.default }
};

export const MODE_LABEL: Record<PrepMode, string> = { default: 'Use the default', custom: 'Custom for this printer', none: 'None' };

/** The settings that apply to one printer. A custom leveling command left empty uses the kind's default. */
export function resolvePrep(g: PrepGlobal, p: PrepPrinter | null | undefined, kind: PrinterKind): ResolvedPrep {
	const pp = p ?? PRINTER_DEFAULTS;
	let snippet: ResolvedPrep['snippet'] = null;
	if (pp.snippet.mode === 'custom') snippet = { gcode: pp.snippet.gcode, match: pp.snippet.match, skipPattern: pp.snippet.skipPattern, source: 'custom' };
	else if (pp.snippet.mode === 'default' && g.snippet.enabled) snippet = { gcode: g.snippet.gcode, match: g.snippet.match, skipPattern: g.snippet.skipPattern, source: 'default' };
	if (snippet && !commandLines(snippet.gcode).length) snippet = null;
	let leveling: ResolvedPrep['leveling'] = null;
	if (pp.leveling.mode === 'custom') {
		leveling = { command: pp.leveling.command.trim() || DEFAULT_LEVEL_COMMAND[kind], skipPattern: pp.leveling.skipPattern, heatBed: pp.leveling.heatBed, bedTemp: pp.leveling.bedTemp, source: 'custom' };
	} else if (pp.leveling.mode === 'default' && g.leveling.enabled) {
		const command = (kind === 'moonraker' ? g.leveling.klipperCommand : g.leveling.octoprintCommand).trim() || DEFAULT_LEVEL_COMMAND[kind];
		leveling = { command, skipPattern: g.leveling.skipPattern, heatBed: g.leveling.heatBed, bedTemp: g.leveling.bedTemp, source: 'default' };
	}
	return { snippet, leveling, timeoutMs: g.timeoutMin * 60_000 };
}

// --- G-code text -----------------------------------------------------------------------

/** A line without its comment, line number and checksum, trimmed (case kept). */
export function stripLine(raw: string): string {
	let s = raw;
	const semi = s.indexOf(';');
	if (semi >= 0) s = s.slice(0, semi);
	s = s.trim();
	s = s.replace(/^N\d+\s*/i, '').replace(/\*\d+\s*$/, '');
	return s.trim();
}

/**
 * One command for comparing: comments, line numbers and checksums gone, upper case,
 * single spaces, leading zeros dropped (G01 → G1), a space after the G/M/T code
 * (`G1X10` → `G1 X10`). `commands`: only the first word. Null for an empty line.
 */
export function normalizeLine(raw: string, mode: MatchMode = 'exact'): string | null {
	let s = stripLine(raw).toUpperCase().replace(/\s+/g, ' ');
	if (!s) return null;
	s = s.replace(/^([GMT])0*(\d+(?:\.\d+)?)(?=[A-Z]|$|\s)/, '$1$2');
	s = s.replace(/^([GMT]\d+(?:\.\d+)?)(?=[A-Z])/, '$1 ');
	if (mode === 'commands') return s.split(' ')[0];
	return s;
}

/** The commands of a snippet or leveling command, as sent: comments and blank lines dropped. */
export function commandLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map(stripLine)
		.filter((l) => l.length > 0);
}

/** Where the start block ends: the first layer change (PrusaSlicer, OrcaSlicer, Cura, Simplify3D, ideaMaker). */
const LAYER_MARKER = /^;\s*(?:LAYER_CHANGE\b|CHANGE_LAYER\b|LAYER:\s*-?\d+|layer\s+-?\d+\s*,|LAYER\s+-?\d+\s*$)/i;

export function isLayerMarker(line: string): boolean {
	return LAYER_MARKER.test(line.trim());
}

/** The lines of a file's start, up to (not including) its first layer change. */
export function startBlock(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (isLayerMarker(line)) break;
		out.push(line);
	}
	return out;
}

/** Checks a "skip if the file contains" pattern; a message for people when it's not usable. */
export function patternError(p: string): string | null {
	const s = p.trim();
	if (!s) return null;
	if (s.length > MAX_PATTERN) return `Keep the pattern under ${MAX_PATTERN} characters`;
	const m = /^\/(.+)\/([a-z]*)$/s.exec(s);
	if (!m) return null;
	if (/[^imsu]/.test(m[2])) return 'Regular expression flags can be i, m, s and u';
	try {
		new RegExp(m[1], m[2]);
	} catch (err) {
		return `Not a valid regular expression: ${(err as Error).message}`;
	}
	return null;
}

/**
 * A line matcher for a pattern: `/regex/flags` tests the command part of each line
 * (comments removed, case as written); anything else is plain text, matched
 * case-insensitively. Null for an empty or invalid pattern.
 */
export function compilePattern(p: string): ((line: string) => boolean) | null {
	const s = p.trim();
	if (!s || patternError(s)) return null;
	const m = /^\/(.+)\/([a-z]*)$/s.exec(s);
	if (m) {
		const re = new RegExp(m[1], m[2].replace('g', ''));
		return (line) => re.test(stripLine(line));
	}
	const needle = s.toUpperCase().replace(/\s+/g, ' ');
	return (line) => stripLine(line).toUpperCase().replace(/\s+/g, ' ').includes(needle);
}

/**
 * Whether every command of the snippet appears in the file's start, in order (other
 * lines may come between). `missing`: the first command not found.
 */
export function snippetInFile(snippet: string, head: string[], match: MatchMode = 'exact'): { present: boolean; missing: string | null } {
	const raw = commandLines(snippet);
	const want = raw.map((l) => normalizeLine(l, match));
	if (!want.length) return { present: true, missing: null };
	let i = 0;
	for (const line of head) {
		if (i >= want.length) break;
		if (normalizeLine(line, match) === want[i]) i++;
	}
	return { present: i >= want.length, missing: i >= want.length ? null : match === 'commands' ? raw[i].split(/\s+/)[0] : raw[i] };
}

/** Commands that probe the bed. `M420 S1` and `BED_MESH_PROFILE LOAD` only load a saved mesh: not leveling. */
const LEVEL_COMMANDS = /^(?:G29(?:\.\d+)?|G80|BED_MESH_CALIBRATE)$/;

/** The first line of the file's start that levels the bed (G29, G80, BED_MESH_CALIBRATE), or null. */
export function levelingInFile(head: string[]): string | null {
	for (const line of head) {
		const c = normalizeLine(line, 'commands');
		if (c && LEVEL_COMMANDS.test(c)) return stripLine(line);
	}
	return null;
}

/** The first line matching a pattern, or null. */
export function patternInFile(pattern: string, head: string[]): string | null {
	const test = compilePattern(pattern);
	if (!test) return null;
	for (const line of head) if (stripLine(line) && test(line)) return stripLine(line);
	return null;
}

/**
 * The bed temperature the file asks for first: M140/M190 S…, or a start macro's
 * BED= / BED_TEMP= / BEDTEMP= parameter (Klipper START_PRINT / PRINT_START). Null if none.
 */
export function bedTempInFile(head: string[]): number | null {
	for (const line of head) {
		const s = normalizeLine(line);
		if (!s) continue;
		let m = /^M1[49]0 (?:.* )?[SR](\d+(?:\.\d+)?)\b/.exec(s);
		if (!m && !/^[GMT]\d/.test(s)) m = /\bBED(?:_?TEMP(?:ERATURE)?)?\s*=\s*(\d+(?:\.\d+)?)/.exec(s);
		if (m) {
			const t = Number(m[1]);
			if (t > 0) return t;
		}
	}
	return null;
}

/** The command that heats the bed and waits (Klipper runs M190 natively, too). */
export function heatCommands(temp: number): string[] {
	return [`M190 S${Math.round(temp)}`];
}

/**
 * What runs before a print. `head`: the file's start (null when it couldn't be read:
 * then every enabled step runs).
 */
export function buildPlan(r: ResolvedPrep, head: string[] | null): PrepPlan {
	const steps: PrepStep[] = [];
	const headRead = head !== null;
	const lines = head ?? [];
	if (r.leveling) {
		const own = headRead ? levelingInFile(lines) : null;
		const pat = headRead && !own ? patternInFile(r.leveling.skipPattern, lines) : null;
		const run = !own && !pat;
		const commands = commandLines(r.leveling.command);
		if (run && r.leveling.heatBed) {
			const fileTemp = headRead ? bedTempInFile(lines) : null;
			const t = fileTemp ?? r.leveling.bedTemp;
			steps.push({
				kind: 'heat',
				label: `Heat the bed to ${Math.round(t)} °C`,
				run: true,
				reason: fileTemp != null ? 'The file’s first bed temperature' : 'The temperature set for leveling (the file names none)',
				commands: heatCommands(t)
			});
		}
		steps.push({
			kind: 'level',
			label: 'Level the bed',
			run,
			reason: own ? `The file levels the bed itself (${own})` : pat ? `The file contains “${pat}”` : headRead ? 'The file doesn’t level the bed' : 'The file couldn’t be read, so leveling runs',
			commands
		});
	}
	if (r.snippet) {
		const found = headRead ? snippetInFile(r.snippet.gcode, lines, r.snippet.match) : { present: false, missing: null };
		const pat = headRead && !found.present ? patternInFile(r.snippet.skipPattern, lines) : null;
		steps.push({
			kind: 'snippet',
			label: 'Pre-print G-code',
			run: !found.present && !pat,
			reason: found.present ? 'Already in the file' : pat ? `The file contains “${pat}”` : headRead ? `Not in the file${found.missing ? ` (no ${found.missing})` : ''}` : 'The file couldn’t be read, so it runs',
			commands: commandLines(r.snippet.gcode)
		});
	}
	return { configured: !!(r.leveling || r.snippet), steps, headRead };
}

/** Whether anything would run before the file. */
export const planRuns = (p: PrepPlan) => p.steps.some((s) => s.run);

/** What the printer shows for a step. */
export function stepStatus(kind: Preparing['step']): string {
	switch (kind) {
		case 'checking':
			return 'Checking the file…';
		case 'heat':
			return 'Heating the bed for leveling…';
		case 'level':
			return 'Leveling the bed…';
		case 'snippet':
			return 'Running the pre-print G-code…';
		case 'starting':
			return 'Starting the print…';
	}
}
