import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { normalizeBaseUrl } from '#lib/server/octoprint/client.ts';
import { appKeys } from '#lib/server/discovery/appkeys.ts';
import type { RequestHandler } from './$types';

/** Starts an Application Keys request on an OctoPrint (`{ baseUrl, verifyTls, user? }`). */
export const POST: RequestHandler = handler(async ({ request }) => {
	const b = await body(request);
	let baseUrl: string;
	try {
		baseUrl = normalizeBaseUrl(typeof b.baseUrl === 'string' ? b.baseUrl : '');
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	const user = typeof b.user === 'string' && b.user.trim() ? b.user.trim().slice(0, 100) : undefined;
	return json(await appKeys.start(baseUrl, { verifyTls: b.verifyTls !== false, user }));
});
