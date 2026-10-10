import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requireEntry } from '#lib/server/history/access.ts';
import { getThumbnail } from '#lib/server/history/store.ts';
import type { RequestHandler } from './$types';

/** The snapshot taken when the print ended. */
export const GET: RequestHandler = handler(({ locals, params }) => {
	const r = requireEntry(locals.user, params.entry);
	const t = getThumbnail(r.id);
	if (!t) return json({ message: 'No picture for this print' }, { status: 404 });
	return new Response(Buffer.from(t.data), { headers: { 'content-type': t.type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } });
});
