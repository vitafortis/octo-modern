import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { controlTarget, refreshSoon } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { bytesLabel } from '#lib/server/octoprint/files-util.ts';
import type { RequestHandler } from './$types';

/**
 * Uploads G-code: the browser's multipart body (field `file`) is streamed straight
 * through to the printer (OctoPrint's POST /api/files/<origin>, Moonraker's
 * /server/files/upload), never buffered here, so large files cost no memory. Options:
 * `?origin=local|sdcard&path=<folder>&select=1&print=1&name=<file name, for the log>`.
 * Both servers need the Content-Length, so the browser's is forwarded.
 */
export const POST: RequestHandler = handler(async ({ params, locals, request, url }) => {
	const { printer, backend } = controlTarget(locals.user, params.id);
	const type = request.headers.get('content-type') ?? '';
	if (!type.toLowerCase().startsWith('multipart/form-data')) throw new BadRequest('Send the file as multipart/form-data (field "file")');
	const length = request.headers.get('content-length');
	if (!length || !/^\d+$/.test(length)) return json({ message: 'Content-Length required (the printer needs it for uploads)' }, { status: 411 });
	if (!request.body) throw new BadRequest('Empty upload');

	const q = url.searchParams;
	const origin = q.get('origin') === 'sdcard' ? 'sdcard' : 'local';
	const path = (q.get('path') ?? '').replace(/^\/+|\/+$/g, '');
	if (path.split('/').includes('..')) throw new BadRequest('Bad folder');
	const flag = (k: string) => q.get(k) === '1' || q.get(k) === 'true';
	const result = await backend.upload({
		body: request.body,
		contentType: type,
		length: Number(length),
		origin,
		folder: path,
		select: flag('select') || flag('print'),
		print: flag('print'),
		// The browser leaving aborts it; a stalled transfer times out after 5 idle minutes.
		signal: request.signal,
		timeoutMs: 5 * 60_000
	});
	const name = result.path ?? q.get('name') ?? 'file';
	audit(locals, 'file.upload', {
		printer,
		detail: `${origin === 'sdcard' ? 'SD: ' : ''}${name} (${bytesLabel(Number(length))})${flag('print') ? (result.printing ? ', printing' : ', print requested but the printer wasn’t ready') : ''}`
	});
	if (result.printing) audit(locals, 'job.start', { printer, detail: name });
	refreshSoon(printer.id);
	return json({ ok: true, origin, path: result.path, selected: result.selected, printing: result.printing }, { status: 201 });
});
