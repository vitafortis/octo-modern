import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { testServer } from '#lib/server/octoprint/probe.ts';
import { getApiKey } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** Tests a saved server with its stored key. */
export const POST: RequestHandler = handler(async ({ params, locals }) => {
	const p = requirePrinter(locals.user, params.id);
	const apiKey = getApiKey(p.id);
	if (!apiKey) return json({ ok: false, error: { message: 'No API key saved', code: 'NO_KEY', hint: 'Edit the server and paste an API key.' } });
	return json(await testServer({ baseUrl: p.baseUrl, apiKey, verifyTls: p.verifyTls }));
});
