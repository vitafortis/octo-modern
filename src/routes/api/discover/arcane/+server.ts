import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { scanArcaneAll } from '#lib/server/discovery/arcane.ts';
import { prepare } from '#lib/server/discovery/index.ts';
import type { RequestHandler } from './$types';

/** OctoPrint containers in every environment of every connected Arcane (admins). */
export const GET: RequestHandler = handler(async () => {
	const scans = await scanArcaneAll();
	prepare(scans.flatMap((s) => s.environments.flatMap((e) => e.candidates)));
	return json(scans);
});
