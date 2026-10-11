import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { saveSpoolmanSettings, spoolmanSettings } from '#lib/server/spools/spoolman.ts';
import type { RequestHandler } from './$types';

/** Spoolman connection (admins; the auth header's value never comes back). */
export const GET: RequestHandler = handler(() => json(spoolmanSettings()));

/** `{ url, authHeader?, authValue?, lowThresholdG?, progressive? }`; an empty `authValue` keeps the stored one, null clears it. */
export const PUT: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request);
	let s;
	try {
		s = saveSpoolmanSettings(b);
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	audit(locals, 'settings.spoolman', { detail: s.url ? `${s.url}${s.authHeader ? ` (with ${s.authHeader} header)` : ''}, low below ${s.lowThresholdG} g` : 'disconnected' });
	return json(s);
});
