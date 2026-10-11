/**
 * Failure detection while printers print: every few seconds (per printer), a webcam
 * frame goes to Obico's ML API (via a one-time link, frames.ts), the detections feed
 * the failure score (score.ts), and crossing the lines notifies or pauses.
 *
 * Rules:
 * - Frames only while the state is "printing", after the printer's "skip the first N
 *   minutes" (by OctoPrint's print time), never while paused, and not at all after
 *   someone marks a false alarm for this print.
 * - Warning (score ⅓): one `failure.suspected` notification; it re-arms once the score
 *   has been back to normal for 10 minutes.
 * - Failure (score ⅔): once per print, the printer's action: nothing, notify, or pause
 *   (OctoPrint's pause, audited as "octo·modern detector") and notify.
 *
 * State lives in memory per printer (the long-term baseline is persisted), so a
 * restart mid-print starts the print's score afresh, like a new print would.
 */
import { addAudit, getApiKey, listPrinters } from '../store.ts';
import { printers } from '../octoprint/manager.ts';
import { backendFor } from '../backend/index.ts';
import { cameraFor, cameraHeaders } from '../octoprint/webcam.ts';
import { httpFetch } from '../octoprint/transport.ts';
import { refreshSoon } from '../control.ts';
import { jobActive } from '#lib/printer.ts';
import { addFrame, assess, newPrintScore, WARNING_AT, type Detection, type PrintScore } from './score.ts';
import { frameUrl, issueFrame, revokeFrame } from './frames.ts';
import { predict, type MlApiConfig } from './obico.ts';
import { annotateJpeg, isJpeg, jpegSize } from './annotate.ts';
import { loadBaseline, mlConfig, printerSettings, saveBaseline } from './settings.ts';
import { notifyFailure, type FailureInfo } from './notify.ts';
import type { DetectEvent, DetectLevel, DetectPoint, DetectStatus, PrinterDetectSettings } from '#lib/detect.ts';
import type { Printer } from '#lib/types.ts';

export const DETECTOR = 'octo·modern detector';
const HISTORY_MAX = 360;
const EVENTS_MAX = 40;
const REARM_MS = 10 * 60_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

interface Run {
	path: string;
	file: string;
	startedAt: number;
	lastPrintTime: number | null;
	ended: boolean;
	score: PrintScore;
	normalized: number | null;
	level: DetectLevel;
	history: DetectPoint[];
	events: DetectEvent[];
	last: DetectStatus['last'];
	frame: Uint8Array | null;
	error: string | null;
	dismissed: { by: string; at: number } | null;
	warned: boolean;
	okSince: number | null;
	failureHandled: boolean;
	nextAt: number;
	busy: boolean;
}

const G = globalThis as typeof globalThis & { __ocmDetectRuns?: Map<string, Run> };
const runs: Map<string, Run> = (G.__ocmDetectRuns ??= new Map());

function newRun(path: string, file: string, startedAt: number): Run {
	return {
		path,
		file,
		startedAt,
		lastPrintTime: null,
		ended: false,
		score: newPrintScore(),
		normalized: null,
		level: 'ok',
		history: [],
		events: [],
		last: null,
		frame: null,
		error: null,
		dismissed: null,
		warned: false,
		okSince: null,
		failureHandled: false,
		nextAt: 0,
		busy: false
	};
}

function event(run: Run, kind: DetectEvent['kind'], detail: string, now = Date.now()) {
	run.events.push({ at: now, kind, detail });
	if (run.events.length > EVENTS_MAX) run.events.splice(0, run.events.length - EVENTS_MAX);
}

/** The run for the printer's current print (a new one when the print changed), or null when it isn't printing. */
function currentRun(id: string, now: number): Run | null {
	const snap = printers.snapshot(id);
	let run = runs.get(id) ?? null;
	if (!snap || !jobActive(snap.state)) {
		if (run && !run.ended && snap && snap.state !== 'unknown' && snap.state !== 'offline') run.ended = true;
		return null;
	}
	const f = snap.job?.file;
	const path = f?.path ?? f?.name ?? '';
	const printTime = snap.progress?.printTime ?? null;
	const restarted = !!run && printTime != null && run.lastPrintTime != null && printTime + 60 < run.lastPrintTime;
	if (!run || run.ended || run.path !== path || restarted) {
		run = newRun(path, f?.display ?? f?.name ?? 'print', printTime != null ? now - printTime * 1000 : now);
		runs.set(id, run);
	}
	run.lastPrintTime = printTime;
	return run;
}

/** One pass over all printers: starts any frame that's due. Called every second by the job. */
export function tick(now = Date.now()): Promise<void>[] {
	const cfg = mlConfig();
	const started: Promise<void>[] = [];
	for (const p of listPrinters()) {
		const run = currentRun(p.id, now);
		if (!run) continue;
		const s = printerSettings(p.id);
		if (!s.enabled || !cfg || run.dismissed || run.busy) continue;
		const snap = printers.snapshot(p.id);
		if (snap?.state !== 'printing') continue;
		const elapsedS = run.lastPrintTime ?? (now - run.startedAt) / 1000;
		if (elapsedS < s.skipMinutes * 60) continue;
		if (now < run.nextAt) continue;
		run.busy = true;
		run.nextAt = now + s.intervalS * 1000;
		started.push(
			analyse(p, run, s, cfg).finally(() => {
				run.busy = false;
			})
		);
	}
	return started;
}

/** One frame from the printer's first camera, fetched by octo·modern. */
export async function grabFrame(p: Printer): Promise<{ bytes: Uint8Array; type: string }> {
	const cam = await cameraFor(p);
	if (!cam?.snapshotUrl) throw new Error('This printer has no webcam snapshot URL');
	const res = await httpFetch(cam.snapshotUrl, { headers: cameraHeaders(p, cam.snapshotUrl, getApiKey(p.id)), signal: AbortSignal.timeout(8_000) }, p.verifyTls);
	const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
	if (!res.ok || !type.startsWith('image/')) {
		await res.body?.cancel();
		throw new Error(`The webcam answered ${res.status}${type ? ` (${type})` : ''}`);
	}
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes.length > MAX_FRAME_BYTES) throw new Error('The webcam frame is larger than 8 MB');
	return { bytes, type };
}

/** Sends `bytes` to the ML API through a one-time link. */
export async function detectFrame(printerId: string, cfg: MlApiConfig & { publicUrl: string }, bytes: Uint8Array, type = 'image/jpeg'): Promise<Detection[]> {
	const token = issueFrame(printerId, bytes, type);
	try {
		return await predict(cfg, frameUrl(cfg.publicUrl, token));
	} finally {
		revokeFrame(token);
	}
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

async function analyse(p: Printer, run: Run, s: PrinterDetectSettings, cfg: MlApiConfig & { publicUrl: string }): Promise<void> {
	let frame: { bytes: Uint8Array; type: string };
	let detections: Detection[];
	try {
		frame = await grabFrame(p);
		detections = await detectFrame(p.id, cfg, frame.bytes, frame.type);
	} catch (err) {
		const msg = (err as Error).message;
		if (run.error !== msg) event(run, 'error', msg);
		run.error = msg;
		return;
	}
	if (runs.get(p.id) !== run || run.ended || run.dismissed) return;
	const now = Date.now();
	const next = addFrame(run.score, loadBaseline(p.id), detections);
	run.score = next.score;
	saveBaseline(p.id, next.base);
	const a = assess(next.score, next.base, s.sensitivity);
	run.normalized = a.score;
	run.level = a.level;
	run.error = null;
	run.history.push({ at: now, score: Math.round(a.score * 1000) / 1000 });
	if (run.history.length > HISTORY_MAX) run.history.splice(0, run.history.length - HISTORY_MAX);
	const size = isJpeg(frame.bytes) ? jpegSize(frame.bytes) : null;
	run.frame = isJpeg(frame.bytes) ? annotateJpeg(frame.bytes, detections) : frame.bytes;
	run.last = {
		at: now,
		width: size?.width ?? null,
		height: size?.height ?? null,
		boxes: size
			? detections.map((d) => ({
					confidence: Math.round(d.confidence * 1000) / 1000,
					box: [d.box[0] / size.width, d.box[1] / size.height, d.box[2] / size.width, d.box[3] / size.height] as [number, number, number, number]
				}))
			: []
	};
	await react(p, run, s, a.level, a.score, now);
}

async function react(p: Printer, run: Run, s: PrinterDetectSettings, level: DetectLevel, score: number, now: number) {
	if (level === 'ok') {
		run.okSince ??= now;
		if (run.warned && !run.failureHandled && now - run.okSince >= REARM_MS) run.warned = false;
		return;
	}
	run.okSince = null;
	const send = (info: FailureInfo) => notifyFailure({ printer: { id: p.id, name: p.name }, file: run.file, info, frame: run.frame });

	if (level === 'failure' && !run.failureHandled) {
		run.failureHandled = true;
		if (s.onFailure === 'pause') {
			run.warned = true;
			let action: FailureInfo['action'] = 'paused';
			try {
				await backendFor(p).jobCommand('pause');
				addAudit({ userId: null, userEmail: DETECTOR, action: 'job.pause', printerId: p.id, printerName: p.name, detail: `${run.file}: failure score ${pct(score)}`, ip: null });
				event(run, 'paused', `Paused the print at failure score ${pct(score)}`, now);
				refreshSoon(p.id);
			} catch (err) {
				action = 'pause-failed';
				event(run, 'error', `Couldn’t pause: ${(err as Error).message}`, now);
			}
			await send({ level: 'failure', score, action });
			return;
		}
		if (s.onFailure === 'notify') {
			run.warned = true;
			event(run, 'failure', `Failure score ${pct(score)}: notified`, now);
			await send({ level: 'failure', score, action: 'notify' });
			return;
		}
		event(run, 'failure', `Failure score ${pct(score)} (action: none)`, now);
	}
	if (!run.warned && score >= WARNING_AT) {
		run.warned = true;
		event(run, 'warning', `Failure score ${pct(score)}: notified`, now);
		await send({ level: 'warning', score, action: 'notify' });
	}
}

/** "This is a false alarm": no frames, alerts or pauses until this print ends. */
export function dismiss(printerId: string, by: string): DetectStatus {
	const run = currentRun(printerId, Date.now());
	if (!run) throw new Error('Nothing to dismiss: the printer isn’t printing');
	if (!run.dismissed) {
		run.dismissed = { by, at: Date.now() };
		event(run, 'dismissed', `Marked as a false alarm by ${by}; detection is off until this print ends`);
	}
	return status(printerId);
}

/** The annotated latest frame. */
export function lastFrame(printerId: string): Uint8Array | null {
	return runs.get(printerId)?.frame ?? null;
}

export function status(printerId: string, now = Date.now()): DetectStatus {
	const settings = printerSettings(printerId);
	const run = currentRun(printerId, now) ?? runs.get(printerId) ?? null;
	const snap = printers.snapshot(printerId);
	const printing = !!run && !run.ended;
	const phase: DetectStatus['phase'] = !settings.enabled
		? 'off'
		: !mlConfig()
			? 'unconfigured'
			: !printing
				? 'idle'
				: run!.dismissed
					? 'dismissed'
					: snap?.state !== 'printing'
						? 'paused'
						: (run!.lastPrintTime ?? (now - run!.startedAt) / 1000) < settings.skipMinutes * 60
							? 'waiting'
							: 'watching';
	return {
		settings,
		phase,
		print: run ? { file: run.file, startedAt: run.startedAt } : null,
		score: run?.normalized ?? null,
		level: run?.level ?? 'ok',
		frames: run?.score.frames ?? 0,
		history: run?.history ?? [],
		last: run?.last ?? null,
		error: run?.error ?? null,
		dismissed: run?.dismissed ?? null,
		events: run ? [...run.events].reverse() : [],
		nextFrameAt: phase === 'watching' ? (run?.nextAt ?? null) : phase === 'waiting' ? run!.startedAt + settings.skipMinutes * 60_000 : null
	};
}

/** Drops in-memory state (printer deleted, tests). */
export function forgetRun(printerId?: string) {
	if (printerId) runs.delete(printerId);
	else runs.clear();
}
