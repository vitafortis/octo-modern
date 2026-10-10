import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { listFolder, requireSource } from '#lib/server/library/service.ts';
import type { RequestHandler } from './$types';

/** A folder of a source: `?path=parts/clips` ('' = the root). Cached slicer metadata comes along. */
export const GET: RequestHandler = handler(async ({ locals, params, url }) => {
	const src = requireSource(locals.user, params.source);
	return json(await listFolder(src, url.searchParams.get('path') ?? ''), { headers: { 'cache-control': 'no-store' } });
});
