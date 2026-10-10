/**
 * Control-tab actions from the browser (POST /api/printers/<id>/control). Movement is
 * refused by the server while printing (409 with the reason, shown as a toast); custom
 * G-code goes through the same confirmation flow as the terminal.
 */
import { act } from './actions.ts';
import type { PrinterProfile } from '#lib/control/profile.ts';
import type { CustomControl } from '#lib/control/custom.ts';

export interface ControlInfo {
	profile: PrinterProfile;
	controls: CustomControl[];
	controlsError: string | null;
}

const url = (id: string) => `/api/printers/${encodeURIComponent(id)}/control`;

export function control(id: string, body: Record<string, unknown>, opts: { done?: string; failed?: string; ask?: Parameters<typeof act>[2]['ask'] } = {}) {
	return act(url(id), body, { done: opts.done, ask: opts.ask, failed: opts.failed ?? 'The printer didn’t accept that' });
}

export { url as controlUrl };
