import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { normalizeBaseUrl } from '#lib/server/octoprint/client.ts';
import { testServer } from '#lib/server/octoprint/probe.ts';
import { getApiKey, getPrinter } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/**
 * Tests a server form before saving (admins): `{ baseUrl, apiKey, verifyTls }`, or
 * `{ id, baseUrl, verifyTls }` to test edited settings with the stored key.
 */
export const POST: RequestHandler = handler(async ({ request }) => {
	const b = await body(request);
	let baseUrl: string;
	try {
		baseUrl = normalizeBaseUrl(typeof b.baseUrl === 'string' ? b.baseUrl : '');
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	let apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
	if (!apiKey && typeof b.id === 'string' && getPrinter(b.id)) apiKey = getApiKey(b.id) ?? '';
	if (!apiKey) throw new BadRequest('Paste an API key to test with');
	return json(await testServer({ baseUrl, apiKey, verifyTls: b.verifyTls !== false }));
});
