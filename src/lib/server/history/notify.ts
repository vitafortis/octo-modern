/**
 * Moved to src/lib/server/notify/ (channels, rules, quiet hours, delivery log). Kept so
 * code that imports the old module keeps working: call `notify(event)` with a kind
 * from #lib/notify.ts.
 */
import type { PrintRecord } from '#lib/history.ts';
import { endEvent } from '../notify/bridge.ts';
import { notify } from '../notify/service.ts';

export { notify } from '../notify/service.ts';
export type { NotifyEvent } from '../notify/types.ts';

/** Print queue events (see queue/dispatcher.ts); rules route them like any other kind. */
export type QueueEventKind = 'queue.bed_clear_needed';
export const QUEUE_EVENTS: QueueEventKind[] = ['queue.bed_clear_needed'];

/** Notifies the channels whose rules want this print's outcome. Never throws. */
export async function notifyPrintEnded(r: PrintRecord): Promise<void> {
	const ev = endEvent(r);
	if (ev) await notify(ev);
}

/** A queue event (e.g. a printer waiting for someone to clear its bed), with a webcam snapshot. Never throws. */
export async function notifyQueueEvent(event: QueueEventKind, opts: { title: string; message: string; printer: { id: string; name: string } }): Promise<void> {
	await notify({
		kind: event,
		printerId: opts.printer.id,
		printerName: opts.printer.name,
		title: opts.title,
		message: opts.message,
		link: `/p/${encodeURIComponent(opts.printer.id)}?tab=queue`,
		dedupeKey: opts.message
	});
}

/** Smart plug events (power/service.ts). */
export type PowerEvent = 'power.on' | 'power.off';
export const POWER_EVENTS: PowerEvent[] = ['power.on', 'power.off'];

/** A printer's smart plug switched (who did it is in `message`). No snapshot: the camera may be on the same plug. Never throws. */
export async function notifyPower(event: PowerEvent, printer: { id: string; name: string }, message: string): Promise<void> {
	await notify({ kind: event, printerId: printer.id, printerName: printer.name, title: `${event === 'power.on' ? 'Power on' : 'Power off'}: ${printer.name}`, message, snapshot: false, dedupeKey: `${event}:${Date.now()}` });
}
