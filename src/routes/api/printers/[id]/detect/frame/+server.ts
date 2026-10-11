import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { lastFrame } from '#lib/server/detect/service.ts';
import type { RequestHandler } from './$types';

/** The last frame failure detection analysed, with its boxes drawn in. */
export const GET: RequestHandler = handler(({ params, locals }) => {
	const p = requirePrinter(locals.user, params.id);
	const f = lastFrame(p.id);
	if (!f) return json({ message: 'No frame analysed yet' }, { status: 404 });
	return new Response(f as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } });
});
