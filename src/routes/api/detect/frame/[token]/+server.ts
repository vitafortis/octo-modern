import { takeFrame } from '#lib/server/detect/frames.ts';
import type { RequestHandler } from './$types';

/**
 * One frame for Obico's ML API, by one-time token (see detect/frames.ts). No session:
 * hooks.server.ts lets this path through for GET only, and the token is all it takes.
 * Any unknown, used or expired token is a plain 404.
 */
export const GET: RequestHandler = ({ params }) => {
	const f = takeFrame(params.token);
	if (!f) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
	return new Response(f.bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': f.type, 'content-length': String(f.bytes.length), 'cache-control': 'no-store' } });
};
