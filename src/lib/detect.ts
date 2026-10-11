/** Failure detection: shapes shared by the server and the browser. */

export type FailureAction = 'none' | 'notify' | 'pause';
export type DetectLevel = 'ok' | 'warning' | 'failure';

/** Per-printer settings. */
export interface PrinterDetectSettings {
	enabled: boolean;
	/** Obico's `detective_sensitivity`: 1 is Obico's default; higher reacts sooner. */
	sensitivity: number;
	/** What to do when the score crosses the failure line (warnings always notify). */
	onFailure: FailureAction;
	/** Seconds between frames while printing (Obico's model is tuned for 10). */
	intervalS: number;
	/** Minutes at the start of each print without frames (first layer, purge lines). */
	skipMinutes: number;
}

export const DETECT_DEFAULTS: PrinterDetectSettings = { enabled: false, sensitivity: 1, onFailure: 'notify', intervalS: 10, skipMinutes: 5 };
export const SENSITIVITY = { min: 0.6, max: 1.4 };
export const INTERVAL = { min: 5, max: 120 };
export const SKIP_MINUTES = { min: 0, max: 60 };

/** Admin settings as the browser sees them (the token only as "set"). */
export interface DetectGlobalInfo {
	mlApiUrl: string | null;
	hasToken: boolean;
	publicUrl: string | null;
	/** Which values come from environment variables instead of saved settings. */
	fromEnv: { mlApiUrl: boolean; token: boolean; publicUrl: boolean };
}

export interface DetectBox {
	confidence: number;
	/** Centre x, centre y, width, height, as fractions of the frame (0–1). */
	box: [number, number, number, number];
}

export interface DetectPoint {
	/** Epoch ms. */
	at: number;
	/** Normalized score 0–1 (⅓ warning, ⅔ failure). */
	score: number;
}

export interface DetectEvent {
	at: number;
	kind: 'warning' | 'failure' | 'paused' | 'dismissed' | 'error';
	detail: string;
}

export type DetectPhase =
	/** Detection is off for this printer. */
	| 'off'
	/** On, but the ML API or octo·modern's address for it isn't set. */
	| 'unconfigured'
	/** Not printing. */
	| 'idle'
	/** Printing, within the first minutes. */
	| 'waiting'
	| 'watching'
	/** Paused or pausing: no frames. */
	| 'paused'
	/** Someone marked a false alarm: off until this print ends. */
	| 'dismissed';

export interface DetectStatus {
	settings: PrinterDetectSettings;
	phase: DetectPhase;
	/** The print being (or last) watched. */
	print: { file: string; startedAt: number } | null;
	score: number | null;
	level: DetectLevel;
	frames: number;
	history: DetectPoint[];
	/** The latest analysed frame. */
	last: { at: number; boxes: DetectBox[]; width: number | null; height: number | null } | null;
	/** Last ML/camera error, cleared by the next good frame. */
	error: string | null;
	dismissed: { by: string; at: number } | null;
	events: DetectEvent[];
	nextFrameAt: number | null;
}
