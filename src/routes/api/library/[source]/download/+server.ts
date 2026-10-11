import { BadRequest, handler } from '#lib/server/http.ts';
import { relPath, requireSource } from '#lib/server/library/service.ts';
import { libraryDownload } from '#lib/server/gcode-download.ts';
import { baseName, isPrintable } from '#lib/library.ts';
import type { RequestHandler } from './$types';

/**
 * The raw G-code of a library file (`?path=`), for the toolpath preview, with `Range`
 * support. Anyone who may see the source may preview its files; credentials stay here.
 */
export const GET: RequestHandler = handler(async ({ params, locals, url, request }) => {
	const src = requireSource(locals.user, params.source);
	const path = relPath(url.searchParams.get('path') ?? '');
	if (!path || !isPrintable(path)) throw new BadRequest('"path" must be a G-code file');
	return libraryDownload(src, path, request.headers.get('range'), baseName(path));
});
