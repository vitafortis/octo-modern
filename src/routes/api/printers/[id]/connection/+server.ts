import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, currentState, refreshSoon, viewTarget } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { jobActive } from '#lib/printer.ts';
import type { RequestHandler } from './$types';

/** Ports, baud rates and printer profiles OctoPrint offers, and the current connection. */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const { client } = viewTarget(locals.user, params.id);
	return json(await client.connection());
});

/**
 * `{ command: 'connect', port?, baudrate?, printerProfile?, save?, autoconnect? }` or
 * `{ command: 'disconnect', confirm? }` (disconnecting mid-print needs `confirm: true`).
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, client } = controlTarget(locals.user, params.id);
	const b = await body(request);
	if (b.command === 'connect') {
		const opts = {
			port: typeof b.port === 'string' && b.port !== 'AUTO' ? b.port : undefined,
			baudrate: typeof b.baudrate === 'number' && b.baudrate > 0 ? b.baudrate : undefined,
			printerProfile: typeof b.printerProfile === 'string' ? b.printerProfile : undefined,
			save: b.save === true ? true : undefined,
			autoconnect: typeof b.autoconnect === 'boolean' ? b.autoconnect : undefined
		};
		await client.connect(opts);
		audit(locals, 'printer.connect', { printer, detail: `${opts.port ?? 'auto'} @ ${opts.baudrate ?? 'auto'}${opts.printerProfile ? `, profile ${opts.printerProfile}` : ''}` });
	} else if (b.command === 'disconnect') {
		const state = await currentState(printer.id, client);
		if (jobActive(state) && b.confirm !== true) return confirmRequired('A print is running. Disconnecting stops it. Send confirm: true to disconnect anyway.');
		await client.disconnect();
		audit(locals, 'printer.disconnect', { printer, detail: jobActive(state) ? `during a print (${state})` : undefined });
	} else {
		throw new BadRequest('"command" must be connect or disconnect');
	}
	refreshSoon(printer.id);
	return json({ ok: true });
});
