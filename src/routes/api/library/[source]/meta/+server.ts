import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { fileMeta, requireSource } from '#lib/server/library/service.ts';
import type { RequestHandler } from './$types';

/** Slicer metadata of one file (`?path=`), read from its first and last bytes and cached. */
export const GET: RequestHandler = handler(async ({ locals, params, url }) => {
	const src = requireSource(locals.user, params.source);
	return json(await fileMeta(src, url.searchParams.get('path') ?? ''), { headers: { 'cache-control': 'no-store' } });
});
