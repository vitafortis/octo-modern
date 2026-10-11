import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { normalizeBaseUrl } from '#lib/server/octoprint/client.ts';
import { testPrinter } from '#lib/server/backend/probe.ts';
import { getApiKey, getPrinter } from '#lib/server/store.ts';
import { isPrinterKind } from '#lib/types.ts';
import type { RequestHandler } from './$types';

/**
 * Tests a server form before saving (admins): `{ baseUrl, apiKey, verifyTls, kind? }`, or
 * `{ id, baseUrl, verifyTls }` to test edited settings with the stored key. `kind` is
 * `octoprint` (the default), `moonraker` or `auto` (probes Moonraker, then OctoPrint); the
 * result says which answered. Moonraker may need no key.
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
	if (!apiKey && b.apiKey === undefined && typeof b.id === 'string' && getPrinter(b.id)) apiKey = getApiKey(b.id) ?? '';
	// No kind: OctoPrint, as before Klipper support (the dialog sends 'auto' itself).
	const kind = isPrinterKind(b.kind) ? b.kind : b.kind === 'auto' ? 'auto' : 'octoprint';
	if (!apiKey && kind === 'octoprint') throw new BadRequest('Paste an API key to test with');
	return json(await testPrinter({ baseUrl, apiKey, verifyTls: b.verifyTls !== false, kind }));
});
