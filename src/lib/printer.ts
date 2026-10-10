/**
 * Live printer state, shared by the server (which builds it from OctoPrint) and the
 * browser (which renders it). Pure: no I/O, safe to import anywhere.
 */

/**
 * - `offline`: OctoPrint itself can't be reached
 * - `disconnected`: OctoPrint answers, but no printer is connected to it
 * - the rest follow OctoPrint's printer state flags
 */
export type PrinterState =
	| 'offline'
	| 'disconnected'
	| 'connecting'
	| 'operational'
	| 'printing'
	| 'pausing'
	| 'paused'
	| 'resuming'
	| 'cancelling'
	| 'finishing'
	| 'error'
	| 'unknown';

export interface StateFlags {
	operational?: boolean;
	printing?: boolean;
	cancelling?: boolean;
	pausing?: boolean;
	resuming?: boolean;
	finishing?: boolean;
	closedOrError?: boolean;
	error?: boolean;
	paused?: boolean;
	ready?: boolean;
	sdReady?: boolean;
}

/**
 * Maps OctoPrint's state flags (and its state text, for the in-between states the
 * flags don't express) to one state. Order matters: a cancelling print is also
 * "printing", a pausing one also "paused" on some versions.
 */
export function stateFromFlags(flags: StateFlags | null | undefined, text?: string | null): PrinterState {
	const t = (text ?? '').toLowerCase();
	if (!flags) return stateFromText(t);
	if (flags.error) return 'error';
	if (flags.cancelling) return 'cancelling';
	if (flags.pausing) return 'pausing';
	if (flags.resuming) return 'resuming';
	if (flags.finishing) return 'finishing';
	if (flags.paused) return 'paused';
	if (flags.printing) return 'printing';
	if (flags.operational) return 'operational';
	if (flags.closedOrError) {
		if (/error/.test(t)) return 'error';
		if (/connecting|detecting|opening|handshake|initializing|transfer/.test(t)) return 'connecting';
		return 'disconnected';
	}
	return stateFromText(t);
}

/** OctoPrint's state strings ("Operational", "Printing from SD", "Offline after error", …). */
export function stateFromText(text: string | null | undefined): PrinterState {
	const t = (text ?? '').toLowerCase().trim();
	if (!t) return 'unknown';
	if (t.includes('error')) return 'error';
	if (t.startsWith('cancelling')) return 'cancelling';
	if (t.startsWith('pausing')) return 'pausing';
	if (t.startsWith('resuming')) return 'resuming';
	if (t.startsWith('finishing')) return 'finishing';
	if (t.startsWith('paused')) return 'paused';
	if (t.startsWith('printing') || t.startsWith('sending file')) return 'printing';
	if (t.startsWith('operational') || t === 'ready') return 'operational';
	if (/^(connecting|opening|detecting|initializing|transferring)/.test(t)) return 'connecting';
	if (t.startsWith('offline') || t.startsWith('closed')) return 'disconnected';
	return 'unknown';
}

export const STATE_LABEL: Record<PrinterState, string> = {
	offline: 'Unreachable',
	disconnected: 'Disconnected',
	connecting: 'Connecting',
	operational: 'Ready',
	printing: 'Printing',
	pausing: 'Pausing',
	paused: 'Paused',
	resuming: 'Resuming',
	cancelling: 'Cancelling',
	finishing: 'Finishing',
	error: 'Error',
	unknown: 'Unknown'
};

export type Tone = 'success' | 'primary' | 'warning' | 'danger' | 'muted';

/** Colour family for badges and dots: ready green, printing violet, paused amber, error red. */
export function stateTone(s: PrinterState): Tone {
	switch (s) {
		case 'operational':
			return 'success';
		case 'printing':
		case 'finishing':
		case 'resuming':
			return 'primary';
		case 'paused':
		case 'pausing':
		case 'cancelling':
		case 'connecting':
			return 'warning';
		case 'error':
		case 'offline':
			return 'danger';
		default:
			return 'muted';
	}
}

/** A job is loaded and running or held (cancel applies). */
export function jobActive(s: PrinterState): boolean {
	return s === 'printing' || s === 'paused' || s === 'pausing' || s === 'resuming' || s === 'finishing';
}

/** The printer is connected to OctoPrint and talking. */
export function isConnected(s: PrinterState): boolean {
	return s !== 'offline' && s !== 'disconnected' && s !== 'unknown' && s !== 'connecting';
}

export interface TempReading {
	actual: number | null;
	target: number | null;
}

/** One point of the temperature chart: epoch ms and `[actual, target]` per heater. */
export interface TempSample {
	t: number;
	v: Record<string, [number | null, number | null]>;
}

export interface JobFile {
	name: string;
	/** Path within its origin, e.g. `folder/benchy.gcode`. */
	path: string;
	/** Display name (OctoPrint ≥1.6 keeps the original name of uploads with special characters). */
	display: string;
	origin: 'local' | 'sdcard' | string;
	size: number | null;
	date: number | null;
}

export interface JobInfo {
	file: JobFile | null;
	/** Seconds, from OctoPrint's analysis. */
	estimatedPrintTime: number | null;
	/** Filament per tool from the analysis: length in mm, volume in cm³. */
	filament: Record<string, { length: number | null; volume: number | null }> | null;
	user: string | null;
}

export interface Progress {
	/** 0–100. */
	completion: number | null;
	/** Seconds elapsed. */
	printTime: number | null;
	/** Seconds left, OctoPrint's estimate. */
	printTimeLeft: number | null;
	/** Where the estimate comes from (`linear`, `analysis`, `estimate`, `average`, `mixed-analysis`…). */
	printTimeLeftOrigin: string | null;
	filepos: number | null;
}

/** Everything the UI shows about one printer right now. */
export interface LiveSnapshot {
	id: string;
	state: PrinterState;
	/** OctoPrint's own wording, e.g. "Printing from SD". */
	stateText: string;
	/** The printer's error message (state "error"). */
	printerError: string | null;
	/** Can't talk to OctoPrint: why, and what to do about it. */
	problem: { message: string; hint?: string; code?: string } | null;
	job: JobInfo | null;
	progress: Progress | null;
	temps: Record<string, TempReading>;
	currentZ: number | null;
	/** `push`: live websocket; `poll`: REST polling; `none`: not contacted yet. */
	source: 'push' | 'poll' | 'none';
	/** OctoPrint version, once known. */
	version: string | null;
	/** Epoch ms of the last update from OctoPrint. */
	updatedAt: number;
}

export function emptySnapshot(id: string): LiveSnapshot {
	return {
		id,
		state: 'unknown',
		stateText: 'Unknown',
		printerError: null,
		problem: null,
		job: null,
		progress: null,
		temps: {},
		currentZ: null,
		source: 'none',
		version: null,
		updatedAt: 0
	};
}

/** Heaters in display order: tools, then bed, then chamber. */
export function heaterKeys(temps: Record<string, unknown>): string[] {
	const rank = (k: string) => (k.startsWith('tool') ? Number(k.slice(4)) || 0 : k === 'bed' ? 100 : k === 'chamber' ? 101 : 200);
	return Object.keys(temps).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function heaterLabel(key: string, toolCount = 1): string {
	if (key === 'bed') return 'Bed';
	if (key === 'chamber') return 'Chamber';
	const m = /^tool(\d+)$/.exec(key);
	if (m) return toolCount > 1 ? `Hotend ${Number(m[1]) + 1}` : 'Hotend';
	return key;
}

/** Fixed chart color per heater identity (CSS variables from app.css): tool0, bed, chamber, other tools. */
export function heaterColor(key: string): string {
	if (key === 'tool0') return 'var(--series-1)';
	if (key === 'bed') return 'var(--series-2)';
	if (key === 'chamber') return 'var(--series-3)';
	return 'var(--series-4)';
}

/** `1h 02m`, `12m 05s`, `45s`. */
export function formatDuration(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
	const s = Math.round(seconds);
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
	if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
	return `${sec}s`;
}

/** Wall-clock time a job ends, e.g. "14:35" or "Tue 09:10" when it isn't today. */
export function formatEta(secondsLeft: number | null | undefined, now = Date.now()): string {
	if (secondsLeft == null || !Number.isFinite(secondsLeft) || secondsLeft < 0) return '—';
	const end = new Date(now + secondsLeft * 1000);
	const time = end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	const sameDay = new Date(now).toDateString() === end.toDateString();
	return sameDay ? time : `${end.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

export function formatTemp(v: number | null | undefined): string {
	return v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}°`;
}

/** Total filament of a job in metres, summed over tools. */
export function filamentMeters(job: JobInfo | null): number | null {
	if (!job?.filament) return null;
	let mm = 0;
	let any = false;
	for (const f of Object.values(job.filament)) {
		if (f.length != null && Number.isFinite(f.length)) {
			mm += f.length;
			any = true;
		}
	}
	return any ? mm / 1000 : null;
}

/** Progress shown in lists: rounded completion while a job is active. */
export function progressPercent(s: Pick<LiveSnapshot, 'state' | 'progress'>): number | null {
	if (!jobActive(s.state) && s.state !== 'cancelling') return null;
	const c = s.progress?.completion;
	return c == null ? null : Math.max(0, Math.min(100, c));
}
