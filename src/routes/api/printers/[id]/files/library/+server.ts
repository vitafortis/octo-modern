import { json } from '@sveltejs/kit';
import { BadRequest, body, Forbidden, handler } from '#lib/server/http.ts';
import { controlTarget } from '#lib/server/control.ts';
import { requireSource, sourceAllowsPrinter } from '#lib/server/library/service.ts';
import { cleanFolder, saveToLibrary } from '#lib/server/library/send.ts';
import { cleanRelPath } from '#lib/library.ts';
import type { RequestHandler } from './$types';

/**
 * "Save to library": copies a file from OctoPrint's local storage onto a writable library
 * source, streamed: `{ path, sourceId, folder?, overwrite? }`. 409 `{ exists }` when the
 * source already has that file (resend with `overwrite: true`).
 */
export const POST: RequestHandler = handler(async ({ locals, params, request }) => {
	const { printer, client } = controlTarget(locals.user, params.id);
	const b = await body(request);
	const src = requireSource(locals.user, typeof b.sourceId === 'string' ? b.sourceId : '');
	if (!sourceAllowsPrinter(src, printer.id)) throw new Forbidden(`${src.name} isn’t available to ${printer.name}`);
	let path: string;
	let folder: string;
	try {
		path = cleanRelPath(b.path);
		folder = cleanFolder(b.folder);
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	if (!path) throw new BadRequest('"path" is required');
	const r = await saveToLibrary(locals, { src, printer, client, octoPath: path, folder, overwrite: b.overwrite === true, signal: request.signal });
	if ('exists' in r) return json({ message: `${src.name} already has ${r.exists}. Replace it?`, exists: true, target: r.exists }, { status: 409 });
	return json({ ok: true, ...r }, { status: 201 });
});
