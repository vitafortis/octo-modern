import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { viewTarget } from '#lib/server/control.ts';
import type { RequestHandler } from './$types';

/** Temperature presets: OctoPrint's settings (Settings → Temperatures), or Mainsail's presets on Klipper. */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const { backend } = viewTarget(locals.user, params.id);
	return json({ profiles: await backend.tempProfiles() });
});
