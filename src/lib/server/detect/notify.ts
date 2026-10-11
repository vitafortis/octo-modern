/**
 * `failure.suspected` notifications through the notifications module (notify/): the
 * rules decide which channels get them, and every channel that can show a picture gets
 * the annotated frame (attached, or by link where that's all it takes). Generic
 * webhooks find the detection under `data.detection`.
 */
import { shrinkJpeg } from '../history/jpeg.ts';
import { notify } from '../notify/service.ts';
import type { NotifyEvent } from '../notify/types.ts';
import type { DetectLevel, FailureAction } from '#lib/detect.ts';

export interface FailureInfo {
	level: Exclude<DetectLevel, 'ok'>;
	/** Normalized 0–1. */
	score: number;
	/** What octo·modern did about it. */
	action: FailureAction | 'paused' | 'pause-failed';
}

/** The event for a warning or a failure (pure; the frame becomes the snapshot). */
export function failureEvent(o: { printer: { id: string; name: string }; file: string | null; info: FailureInfo; frame: Uint8Array | null; at?: string }): NotifyEvent {
	const pct = Math.round(o.info.score * 100);
	const what =
		o.info.action === 'paused'
			? 'octo·modern paused the print.'
			: o.info.action === 'pause-failed'
				? 'octo·modern tried to pause the print but OctoPrint refused.'
				: o.info.level === 'failure'
					? 'The print looks like it has failed.'
					: 'The print may be failing.';
	// Attachments stay small: Discord and ntfy have limits, and phones on mobile data.
	const image = o.frame ? shrinkJpeg(o.frame, 400 * 1024) : null;
	return {
		kind: 'failure.suspected',
		severity: o.info.level === 'failure' ? 'error' : 'warning',
		printerId: o.printer.id,
		printerName: o.printer.name,
		title: `${o.info.level === 'failure' ? 'Print failure detected' : 'Failure suspected'}: ${o.printer.name}`,
		message: `${o.printer.name}${o.file ? ` (${o.file})` : ''}: failure score ${pct}%. ${what}`,
		print: o.file ? { file: o.file } : null,
		fields: [
			{ label: 'Failure score', value: `${pct}%` },
			{ label: 'Action', value: o.info.action === 'paused' ? 'paused the print' : o.info.action === 'pause-failed' ? 'pause failed' : o.info.action === 'notify' ? 'notified' : 'none' }
		],
		data: { detection: { level: o.info.level, score: Math.round(o.info.score * 1000) / 1000, action: o.info.action } },
		snapshot: image ? { data: image, type: 'image/jpeg' } : false,
		// The detector decides when to alert again (warnings re-arm, one failure per print).
		dedupeKey: `${o.info.level}:${o.at ?? Date.now()}`,
		link: `/p/${encodeURIComponent(o.printer.id)}?tab=detection`,
		at: o.at
	};
}

/** Sends a warning or failure; never throws. Returns how many channels got it. */
export async function notifyFailure(o: { printer: { id: string; name: string }; file: string | null; info: FailureInfo; frame: Uint8Array | null }): Promise<number> {
	const out = await notify(failureEvent(o));
	return out.filter((x) => x.status === 'sent').length;
}
