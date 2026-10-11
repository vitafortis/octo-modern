import { json } from '@sveltejs/kit';
import { body } from '#lib/server/http.ts';
import { audit, requirePrinter } from '#lib/server/permissions.ts';
import { power } from '#lib/server/power/service.ts';
import { powerHandler, requireAdmin } from '#lib/server/power/api.ts';
import { createAdapter } from '#lib/server/power/adapters.ts';
import { describePlug, getPlug, parsePlugInput } from '#lib/server/power/config.ts';
import type { RequestHandler } from './$types';

/** Reads the status of the plug as entered in the form (not saved; empty secrets use the stored ones). Never switches it. */
export const POST: RequestHandler = powerHandler(async ({ params, locals, request }) => {
	requireAdmin(locals.user);
	const printer = requirePrinter(locals.user, params.id);
	const input = parsePlugInput(await body(request), getPlug(printer.id));
	const started = Date.now();
	try {
		const reading = await createAdapter(input.kind, input.config, input.secrets, power.deps).status();
		audit(locals, 'power.test', { printer, detail: `${describePlug(input)}: ${reading.on == null ? 'state unknown' : reading.on ? 'on' : 'off'}` });
		return json({ ok: true, reading, ms: Date.now() - started });
	} catch (err) {
		audit(locals, 'power.test', { printer, detail: `${describePlug(input)}: ${(err as Error).message}`.slice(0, 480) });
		throw err;
	}
});
