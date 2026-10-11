import { sharedImage } from '#lib/server/notify/media.ts';
import type { RequestHandler } from './$types';

/**
 * A snapshot shared with a notification channel (Slack, Gotify, Home Assistant), by an
 * unguessable link that expires after 48 h. No sign-in: see notify/media.ts.
 */
export const GET: RequestHandler = ({ params }) => {
	const img = sharedImage(params.token);
	if (!img) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
	return new Response(img.data as Uint8Array<ArrayBuffer>, {
		headers: { 'content-type': img.type, 'cache-control': 'private, max-age=172800', 'x-robots-tag': 'noindex' }
	});
};
