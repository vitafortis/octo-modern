import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { testPrinter } from '#lib/server/backend/probe.ts';
import { getApiKey } from '#lib/server/store.ts';
import { canReach } from '#lib/printer-kind.ts';
import type { RequestHandler } from './$types';

/** Tests a saved server with its stored key. */
export const POST: RequestHandler = handler(async ({ params, locals }) => {
	const p = requirePrinter(locals.user, params.id);
	if (!canReach(p)) return json({ ok: false, error: { message: 'No API key saved', code: 'NO_KEY', hint: 'Edit the server and paste an API key.' } });
	return json(await testPrinter({ baseUrl: p.baseUrl, apiKey: getApiKey(p.id) ?? '', verifyTls: p.verifyTls, kind: p.kind }));
});
