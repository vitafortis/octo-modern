import { json } from '@sveltejs/kit';
import { body, handler } from '#lib/server/http.ts';
import { controlTarget } from '#lib/server/control.ts';
import { setTemperatures } from '#lib/server/printer-actions.ts';
import type { RequestHandler } from './$types';

/** Sets heater targets: `{ targets: { tool0: 210, bed: 60 } }` (0 turns a heater off). */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const target = controlTarget(locals.user, params.id);
	const targets = await setTemperatures(target, locals, (await body(request)).targets);
	return json({ ok: true, targets });
});
