import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { cameras, toInfo } from '#lib/server/octoprint/webcam.ts';
import type { RequestHandler } from './$types';

/**
 * The printer's cameras and how to show them. Proxied (MJPEG) cameras carry no URL:
 * use …/webcam/stream?cam=<id> and …/webcam/snapshot?cam=<id>.
 */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const p = requirePrinter(locals.user, params.id);
	return json({ cameras: (await cameras(p)).map(toInfo) });
});
