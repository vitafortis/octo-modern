import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { requireSource, searchFolder } from '#lib/server/library/service.ts';
import type { RequestHandler } from './$types';

/** File names below `?path=` matching every word of `?q=`; printable files only unless `all=1`. Capped (see `truncated`). */
export const GET: RequestHandler = handler(async ({ locals, params, url }) => {
	const src = requireSource(locals.user, params.source);
	const q = (url.searchParams.get('q') ?? '').trim();
	if (q.length < 2) throw new BadRequest('Search for at least 2 characters');
	return json(await searchFolder(src, url.searchParams.get('path') ?? '', q.slice(0, 100), { all: url.searchParams.get('all') === '1' }), {
		headers: { 'cache-control': 'no-store' }
	});
});
