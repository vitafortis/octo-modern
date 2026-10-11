import { json } from '@sveltejs/kit';
import { body, handler } from '#lib/server/http.ts';
import { controlTarget, refreshSoon, validTargets } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

/** Sets heater targets: `{ targets: { tool0: 210, bed: 60 } }` (0 turns a heater off). */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, backend } = controlTarget(locals.user, params.id);
	const targets = validTargets((await body(request)).targets);
	await backend.setTargets(targets);
	audit(locals, 'temperature.set', { printer, detail: Object.entries(targets).map(([h, v]) => `${h} → ${v ? `${v} °C` : 'off'}`).join(', ') });
	refreshSoon(printer.id);
	return json({ ok: true, targets });
});
