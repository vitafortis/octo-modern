import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { normalizeBaseUrl } from '#lib/server/octoprint/client.ts';
import { fingerprintUrl } from '#lib/server/discovery/fingerprint.ts';
import type { RequestHandler } from './$types';

/** Checks one address without a key: is it OctoPrint, which version, Application Keys? */
export const POST: RequestHandler = handler(async ({ request }) => {
	const b = await body(request);
	let baseUrl: string;
	try {
		baseUrl = normalizeBaseUrl(typeof b.baseUrl === 'string' ? b.baseUrl : '');
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	return json({ baseUrl, ...(await fingerprintUrl(baseUrl, { verifyTls: b.verifyTls !== false })) });
});
