import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, currentState, refreshSoon, viewTarget } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { moonrakerBackend, octoprintClient } from '#lib/server/backend/index.ts';
import { jobActive } from '#lib/printer.ts';
import type { RequestHandler } from './$types';

/** Ports, baud rates and printer profiles OctoPrint offers, and the current connection (OctoPrint only). */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const { printer } = viewTarget(locals.user, params.id);
	return json(await octoprintClient(printer, 'Serial connection settings').connection());
});

/**
 * OctoPrint: `{ command: 'connect', port?, baudrate?, printerProfile?, save?, autoconnect? }` or
 * `{ command: 'disconnect', confirm? }` (disconnecting mid-print needs `confirm: true`).
 * Klipper: `{ command: 'firmware_restart' | 'restart', confirm? }` (`connect` means a firmware
 * restart); restarting mid-print needs `confirm: true` too, since it ends the print.
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, backend } = controlTarget(locals.user, params.id);
	const b = await body(request);
	if (printer.kind === 'moonraker') {
		const command = b.command === 'connect' ? 'firmware_restart' : b.command;
		if (command !== 'firmware_restart' && command !== 'restart') throw new BadRequest('"command" must be firmware_restart or restart');
		const state = await currentState(printer.id, backend);
		if (jobActive(state) && b.confirm !== true) return confirmRequired('A print is running. Restarting Klipper ends it. Send confirm: true to restart anyway.');
		const mr = moonrakerBackend(printer);
		if (command === 'restart') await mr.restart();
		else await mr.connect();
		audit(locals, command === 'restart' ? 'printer.klipper_restart' : 'printer.firmware_restart', { printer, detail: jobActive(state) ? `during a print (${state})` : undefined });
		refreshSoon(printer.id, [400, 1500, 4000]);
		return json({ ok: true });
	}
	if (b.command === 'connect') {
		const opts = {
			port: typeof b.port === 'string' && b.port !== 'AUTO' ? b.port : undefined,
			baudrate: typeof b.baudrate === 'number' && b.baudrate > 0 ? b.baudrate : undefined,
			printerProfile: typeof b.printerProfile === 'string' ? b.printerProfile : undefined,
			save: b.save === true ? true : undefined,
			autoconnect: typeof b.autoconnect === 'boolean' ? b.autoconnect : undefined
		};
		await backend.connect(opts);
		audit(locals, 'printer.connect', { printer, detail: `${opts.port ?? 'auto'} @ ${opts.baudrate ?? 'auto'}${opts.printerProfile ? `, profile ${opts.printerProfile}` : ''}` });
	} else if (b.command === 'disconnect') {
		const state = await currentState(printer.id, backend);
		if (jobActive(state) && b.confirm !== true) return confirmRequired('A print is running. Disconnecting stops it. Send confirm: true to disconnect anyway.');
		await backend.disconnect();
		audit(locals, 'printer.disconnect', { printer, detail: jobActive(state) ? `during a print (${state})` : undefined });
	} else {
		throw new BadRequest('"command" must be connect or disconnect');
	}
	refreshSoon(printer.id);
	return json({ ok: true });
});
