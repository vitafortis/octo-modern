import { json } from '@sveltejs/kit';
import { BadRequest, Forbidden, body, handler } from '#lib/server/http.ts';
import { viewTarget } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { parseTimelapseListing, timelapseConfigBody } from '#lib/server/octoprint/timelapse.ts';
import { octoprintClient } from '#lib/server/backend/index.ts';
import type { RequestHandler } from './$types';

/** Rendered and unrendered timelapses, and OctoPrint's timelapse settings. */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const client = octoprintClient(viewTarget(locals.user, params.id).printer, 'Timelapse');
	return json(parseTimelapseListing(await client.get('/api/timelapse?unrendered=true')), { headers: { 'cache-control': 'no-store' } });
});

/** Changes the timelapse settings (admins): `{ type: off | zchange | timed, fps, interval, postRoll, retractionZHop, minDelay }`. */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	if (locals.user?.role !== 'admin') throw new Forbidden('Only admins can change the timelapse settings');
	const { printer } = viewTarget(locals.user, params.id);
	const client = octoprintClient(printer, 'Timelapse');
	let payload: Record<string, unknown>;
	try {
		payload = timelapseConfigBody(await body(request));
	} catch (err) {
		throw err instanceof BadRequest ? err : new BadRequest((err as Error).message);
	}
	await client.post('/api/timelapse', payload);
	const { save: _save, ...shown } = payload;
	audit(locals, 'timelapse.config', { printer, detail: Object.entries(shown).map(([k, v]) => `${k}=${v}`).join(' ') });
	return json(parseTimelapseListing(await client.get('/api/timelapse?unrendered=true')));
});
