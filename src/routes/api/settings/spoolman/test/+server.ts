import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { testSpoolman } from '#lib/server/spools/spoolman.ts';
import type { RequestHandler } from './$types';

/** Tries the saved connection: `{ ok, version, spools }` or `{ ok: false, message }`. */
export const POST: RequestHandler = handler(async () => {
	try {
		return json({ ok: true, ...(await testSpoolman()) });
	} catch (err) {
		return json({ ok: false, message: (err as Error).message });
	}
});
