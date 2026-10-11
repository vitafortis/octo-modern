import { BadRequest, handler } from '#lib/server/http.ts';
import { viewTarget } from '#lib/server/control.ts';
import { octoprintDownload } from '#lib/server/gcode-download.ts';
import { isGcodeName } from '#lib/server/octoprint/files.ts';
import { cleanRelPath } from '#lib/library.ts';
import type { RequestHandler } from './$types';

/**
 * The raw G-code of a file in OctoPrint's local storage (`?path=`), for the toolpath
 * preview. Streamed with the server's API key; `Range` requests pass through. Anyone
 * who can see the printer may preview its files. (SD card files can't be downloaded.)
 */
export const GET: RequestHandler = handler(async ({ params, locals, url, request }) => {
	const { client } = viewTarget(locals.user, params.id);
	let path: string;
	try {
		path = cleanRelPath(url.searchParams.get('path') ?? '');
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	if (!path || !isGcodeName(path)) throw new BadRequest('"path" must be a G-code file');
	return octoprintDownload(client, path, request.headers.get('range'), request.signal);
});
