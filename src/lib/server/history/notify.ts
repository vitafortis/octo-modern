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

/** Notifies the channels whose rules want this print's outcome. Never throws. */
export async function notifyPrintEnded(r: PrintRecord): Promise<void> {
	const ev = endEvent(r);
	if (ev) await notify(ev);
}
