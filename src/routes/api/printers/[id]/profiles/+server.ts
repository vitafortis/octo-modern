import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { viewTarget } from '#lib/server/control.ts';
import { parseTempProfiles } from '#lib/server/octoprint/parse.ts';
import type { RequestHandler } from './$types';

/** Temperature presets from OctoPrint's settings (Settings → Temperatures). */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const { client } = viewTarget(locals.user, params.id);
	return json({ profiles: parseTempProfiles(await client.settings()) });
});
