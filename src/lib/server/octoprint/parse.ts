/**
 * Turns OctoPrint's REST and push payloads into the shapes in #lib/printer.ts.
 * Defensive throughout: plugins and older versions leave fields out or null.
 */
import { stateFromFlags, stateFromText, type JobInfo, type PrinterState, type Progress, type StateFlags, type TempReading, type TempSample } from '#lib/printer.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface ParsedState {
	state: PrinterState;
	stateText: string;
	printerError: string | null;
}

/** `{ text, flags, error }` from /api/printer, push messages, or a bare state string from /api/job. */
export function parseState(raw: unknown): ParsedState | null {
	if (typeof raw === 'string') return { state: stateFromText(raw), stateText: raw, printerError: null };
	if (!isObj(raw)) return null;
	const text = str(raw.text) ?? '';
	const flags = isObj(raw.flags) ? (raw.flags as StateFlags) : null;
	const state = stateFromFlags(flags, text);
	const error = str(raw.error);
	return { state, stateText: text || state, printerError: error && error.trim() ? error.trim() : null };
}

/** Heater readings from /api/printer's `temperature` or one push `temps` entry; drops absent heaters (null actual and target). */
export function parseTemps(raw: unknown): Record<string, TempReading> {
	const out: Record<string, TempReading> = {};
	if (!isObj(raw)) return out;
	for (const [key, value] of Object.entries(raw)) {
		if (key === 'time' || key === 'history' || !isObj(value)) continue;
		if (!/^(tool\d+|bed|chamber)$/.test(key)) continue;
		const actual = num(value.actual);
		const target = num(value.target);
		if (actual === null && target === null) continue;
		out[key] = { actual, target };
	}
	return out;
}

/** One push `temps` entry (`{ time: <epoch s>, tool0: {...}, … }`) as a chart sample. */
export function tempSample(raw: unknown): TempSample | null {
	if (!isObj(raw)) return null;
	const time = num(raw.time);
	if (time === null) return null;
	const temps = parseTemps(raw);
	const v: TempSample['v'] = {};
	for (const [k, r] of Object.entries(temps)) v[k] = [r.actual, r.target];
	return { t: Math.round(time * 1000), v };
}

export function sampleFromReadings(temps: Record<string, TempReading>, t: number): TempSample {
	const v: TempSample['v'] = {};
	for (const [k, r] of Object.entries(temps)) v[k] = [r.actual, r.target];
	return { t, v };
}

/** The `job` object (REST /api/job or push). Null when no file is selected. */
export function parseJob(raw: unknown): JobInfo | null {
	if (!isObj(raw)) return null;
	const f = isObj(raw.file) ? raw.file : {};
	const name = str(f.name);
	const path = str(f.path) ?? name;
	const file = name
		? {
				name,
				path: path ?? name,
				display: str(f.display) ?? name,
				origin: str(f.origin) ?? 'local',
				size: num(f.size),
				date: num(f.date)
			}
		: null;
	let filament: JobInfo['filament'] = null;
	if (isObj(raw.filament)) {
		const fl = raw.filament;
		// Older versions report a single tool as { length, volume }; newer ones per tool.
		if ('length' in fl || 'volume' in fl) {
			if (num(fl.length) !== null || num(fl.volume) !== null) filament = { tool0: { length: num(fl.length), volume: num(fl.volume) } };
		} else {
			for (const [tool, v] of Object.entries(fl)) {
				if (!isObj(v)) continue;
				filament ??= {};
				filament[tool] = { length: num(v.length), volume: num(v.volume) };
			}
		}
	}
	const estimate = num(raw.estimatedPrintTime);
	const user = str(raw.user);
	if (!file && estimate === null && !filament && !user) return null;
	return { file, estimatedPrintTime: estimate, filament, user };
}

export function parseProgress(raw: unknown): Progress | null {
	if (!isObj(raw)) return null;
	const p: Progress = {
		completion: num(raw.completion),
		printTime: num(raw.printTime),
		printTimeLeft: num(raw.printTimeLeft),
		printTimeLeftOrigin: str(raw.printTimeLeftOrigin),
		filepos: num(raw.filepos)
	};
	return Object.values(p).every((v) => v === null) ? null : p;
}

/** /api/job: `{ job, progress, state, error? }`. */
export function parseJobResponse(raw: unknown): { job: JobInfo | null; progress: Progress | null; state: ParsedState | null } {
	if (!isObj(raw)) return { job: null, progress: null, state: null };
	const state = parseState(raw.state);
	const error = str(raw.error);
	if (state && error) state.printerError = error;
	return { job: parseJob(raw.job), progress: parseProgress(raw.progress), state };
}

/** /api/printer: `{ state, temperature, sd }`. */
export function parsePrinterResponse(raw: unknown): { state: ParsedState | null; temps: Record<string, TempReading> } {
	if (!isObj(raw)) return { state: null, temps: {} };
	return { state: parseState(raw.state), temps: parseTemps(raw.temperature) };
}

/** What a push `current` or `history` message carries. */
export interface PushUpdate {
	state: ParsedState | null;
	job: JobInfo | null;
	progress: Progress | null;
	currentZ: number | null;
	samples: TempSample[];
	logs: string[];
	busyFiles: { origin: string; path: string }[];
}

export function parsePushUpdate(raw: unknown): PushUpdate | null {
	if (!isObj(raw)) return null;
	const samples = Array.isArray(raw.temps) ? raw.temps.map(tempSample).filter((s): s is TempSample => !!s) : [];
	return {
		state: parseState(raw.state),
		job: parseJob(raw.job),
		progress: parseProgress(raw.progress),
		currentZ: num(raw.currentZ),
		samples: samples.sort((a, b) => a.t - b.t),
		logs: Array.isArray(raw.logs) ? raw.logs.filter((l): l is string => typeof l === 'string') : [],
		busyFiles: Array.isArray(raw.busyFiles)
			? raw.busyFiles.filter(isObj).map((b) => ({ origin: str(b.origin) ?? 'local', path: str(b.path) ?? '' }))
			: []
	};
}

/** Temperature presets from /api/settings (`temperature.profiles`). */
export interface TempProfile {
	name: string;
	extruder: number | null;
	bed: number | null;
	chamber: number | null;
}

export function parseTempProfiles(settings: unknown): TempProfile[] {
	if (!isObj(settings) || !isObj(settings.temperature) || !Array.isArray(settings.temperature.profiles)) return [];
	return settings.temperature.profiles.filter(isObj).map((p) => ({
		name: str(p.name) ?? 'Preset',
		extruder: num(p.extruder),
		bed: num(p.bed),
		chamber: num(p.chamber)
	}));
}

/** Webcam URLs OctoPrint reports (classic webcam settings), resolved against the base URL. */
export function parseWebcam(settings: unknown, baseUrl: string): { snapshotUrl: string | null; streamUrl: string | null; flipH: boolean; flipV: boolean; rotate90: boolean; enabled: boolean } {
	const out = { snapshotUrl: null as string | null, streamUrl: null as string | null, flipH: false, flipV: false, rotate90: false, enabled: false };
	if (!isObj(settings) || !isObj(settings.webcam)) return out;
	const w = settings.webcam;
	const resolve = (u: unknown) => {
		const s = str(u)?.trim();
		if (!s) return null;
		try {
			return new URL(s, `${baseUrl}/`).href;
		} catch {
			return null;
		}
	};
	out.enabled = w.webcamEnabled !== false;
	out.snapshotUrl = resolve(w.snapshotUrl);
	out.streamUrl = resolve(w.streamUrl);
	out.flipH = w.flipH === true;
	out.flipV = w.flipV === true;
	out.rotate90 = w.rotate90 === true;
	// OctoPrint ≥1.9 keeps webcams in a list; the classic one mirrors the legacy fields.
	if (Array.isArray(w.webcams) && (!out.snapshotUrl || !out.streamUrl)) {
		for (const cam of w.webcams.filter(isObj)) {
			const compat = isObj(cam.compat) ? cam.compat : {};
			out.snapshotUrl ??= resolve(compat.snapshot);
			out.streamUrl ??= resolve(compat.stream ?? (isObj(cam.extras) ? cam.extras.stream : undefined));
		}
	}
	return out;
}
