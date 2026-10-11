/**
 * The failure score: Obico's first-generation aggregation of the model's detections,
 * ported from obico-server (release branch, commit 6f93896):
 *
 * - backend/lib/prediction.py: per frame `p` = sum of detection confidences; an
 *   exponentially weighted mean (`ewm`, span 12 frames); a "short" rolling mean over
 *   this print (window 310 frames) and a "long" one over the printer's lifetime
 *   (window 7200 frames, ~20 h at one frame every 10 s), the baseline for what this
 *   camera normally looks like.
 * - backend/lib/failure_detection.py: `adjusted = (ewm − long) × sensitivity`. The
 *   warning threshold is `(short − long) × 3.8`, clamped to [0.38, 0.78]; failure is
 *   the warning threshold × 1.75 (ESCALATING_FACTOR). `calc_normalized_p` maps that
 *   onto 0–1 for display: 0–⅓ fine, ⅓–⅔ warning, ⅔–1 failure.
 *
 * Differences, on purpose:
 * - Obico ignores the first 30 frames of a print (INIT_SAFE_FRAME_NUM). Here no
 *   frames are taken at all for the printer's "skip the first N minutes" setting,
 *   which defaults to 5 minutes (30 frames at 10 s) and covers the first layer.
 * - Obico's per-printer `detection_bending_factor` and alert cool-downs live in the
 *   service (service.ts), not here.
 *
 * Pure: state in, state out.
 */

/** One detection from Obico's ML API: `[label, confidence, [xc, yc, w, h]]`, box centre and size in pixels. */
export interface Detection {
	label: string;
	confidence: number;
	box: [number, number, number, number];
}

export const PARAMS = {
	EWM_SPAN: 12,
	ROLLING_WIN_SHORT: 310,
	ROLLING_WIN_LONG: 7200,
	THRESHOLD_LOW: 0.38,
	THRESHOLD_HIGH: 0.78,
	ROLLING_MEAN_SHORT_MULTIPLE: 3.8,
	ESCALATING_FACTOR: 1.75,
	/** Boxes below this confidence aren't drawn (Obico's VISUALIZATION_THRESH). */
	VISUALIZATION_THRESH: 0.2
} as const;

/** Display thresholds of the normalized score. */
export const WARNING_AT = 1 / 3;
export const FAILURE_AT = 2 / 3;

export type Level = 'ok' | 'warning' | 'failure';

/** Per print. */
export interface PrintScore {
	frames: number;
	/** `p` of the latest frame. */
	current: number;
	ewm: number;
	short: number;
}

/** Per printer, across prints (persisted). */
export interface Baseline {
	frames: number;
	long: number;
}

export const newPrintScore = (): PrintScore => ({ frames: 0, current: 0, ewm: 0, short: 0 });
export const newBaseline = (): Baseline => ({ frames: 0, long: 0 });

export const sumConfidence = (d: Detection[]) => d.reduce((s, x) => s + (Number.isFinite(x.confidence) ? x.confidence : 0), 0);

/** prediction.py `next_rolling_mean`: a running mean until the window fills, then an approximate rolling one. */
export function nextRollingMean(p: number, mean: number, count: number, win: number): number {
	return mean + (p - mean) / (win <= count ? win : count + 1);
}

/**
 * prediction.py `update_prediction_with_detections`. Like Obico, the frame counters
 * are incremented before the rolling means use them (so the first frame counts half);
 * kept as is so the thresholds behave as tuned.
 */
export function addFrame(score: PrintScore, base: Baseline, detections: Detection[]): { score: PrintScore; base: Baseline } {
	const p = sumConfidence(detections);
	const alpha = 2 / (PARAMS.EWM_SPAN + 1);
	const frames = score.frames + 1;
	const lifetime = base.frames + 1;
	return {
		score: { frames, current: p, ewm: p * alpha + score.ewm * (1 - alpha), short: nextRollingMean(p, score.short, frames, PARAMS.ROLLING_WIN_SHORT) },
		base: { frames: lifetime, long: nextRollingMean(p, base.long, lifetime, PARAMS.ROLLING_WIN_LONG) }
	};
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const scale = (v: number, a: number, b: number, lo: number, hi: number) => clamp(((v - a) * (hi - lo)) / (b - a) + lo, lo, hi);

export interface Assessment {
	/** 0–1, for display; ⅓ and ⅔ are the warning and failure lines. */
	score: number;
	level: Level;
	/** `(ewm − long) × sensitivity`, Obico's raw quantity. */
	adjusted: number;
	warningThreshold: number;
	failureThreshold: number;
}

/**
 * failure_detection.py `calc_normalized_p` and prediction.py `is_failing` (warning:
 * escalating factor 1; failure: 1.75). `sensitivity` is Obico's `detective_sensitivity`
 * (default 1.0; higher reacts sooner).
 */
export function assess(score: PrintScore, base: Baseline, sensitivity = 1): Assessment {
	const warningThreshold = clamp((score.short - base.long) * PARAMS.ROLLING_MEAN_SHORT_MULTIPLE, PARAMS.THRESHOLD_LOW, PARAMS.THRESHOLD_HIGH);
	const failureThreshold = warningThreshold * PARAMS.ESCALATING_FACTOR;
	const adjusted = (score.ewm - base.long) * sensitivity;
	let normalized: number;
	if (adjusted > failureThreshold) normalized = scale(adjusted, failureThreshold, failureThreshold * 1.5, FAILURE_AT, 1);
	else if (adjusted > warningThreshold) normalized = scale(adjusted, warningThreshold, failureThreshold, WARNING_AT, FAILURE_AT);
	else normalized = scale(adjusted, 0, warningThreshold, 0, WARNING_AT);
	const level: Level = adjusted > failureThreshold ? 'failure' : adjusted > warningThreshold ? 'warning' : 'ok';
	return { score: normalized, level, adjusted, warningThreshold, failureThreshold };
}
