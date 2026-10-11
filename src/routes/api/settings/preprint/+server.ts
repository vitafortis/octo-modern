import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { loadGlobal, saveGlobal, SettingsError } from '#lib/server/preprint/settings.ts';
import { commandLines } from '#lib/preprint.ts';
import type { RequestHandler } from './$types';

/** The default pre-print steps for every printer (admins; /api/settings is admin-only). */
export const GET: RequestHandler = handler(() => json(loadGlobal()));

/** `{ snippet?: {…}, leveling?: {…}, timeoutMin? }`: fields left out are kept. */
export const PUT: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request);
	let next;
	try {
		next = saveGlobal(b);
	} catch (err) {
		if (err instanceof SettingsError) throw new BadRequest(err.message);
		throw err;
	}
	const parts = [
		`leveling ${next.leveling.enabled ? `on (${commandLines(next.leveling.octoprintCommand).join(', ')} / ${commandLines(next.leveling.klipperCommand).join(', ')}${next.leveling.heatBed ? `, heat bed ${next.leveling.bedTemp} °C` : ''})` : 'off'}`,
		`pre-print G-code ${next.snippet.enabled ? `on (${commandLines(next.snippet.gcode).length} lines, match ${next.snippet.match})` : 'off'}`,
		`timeout ${next.timeoutMin} min`
	];
	audit(locals, 'settings.preprint', { detail: parts.join(', ') });
	return json(next);
});
