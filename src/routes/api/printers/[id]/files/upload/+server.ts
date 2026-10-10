import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { controlTarget, refreshSoon } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { bytesLabel } from '#lib/server/octoprint/files-util.ts';
import { streamRequest } from '#lib/server/octoprint/transport.ts';
import { httpError, toOctoPrintError } from '#lib/server/octoprint/errors.ts';
import type { RequestHandler } from './$types';

/**
 * Uploads G-code: the browser's multipart body (field `file`) is streamed straight
 * through to OctoPrint's POST /api/files/<origin>, never buffered here, so large files
 * cost no memory. Options go in the query, which OctoPrint reads like form fields:
 * `?origin=local|sdcard&path=<folder>&select=1&print=1&name=<file name, for the log>`.
 * OctoPrint needs the Content-Length, so the browser's is forwarded.
 */
export const POST: RequestHandler = handler(async ({ params, locals, request, url }) => {
	const { printer, client } = controlTarget(locals.user, params.id);
	const type = request.headers.get('content-type') ?? '';
	if (!type.toLowerCase().startsWith('multipart/form-data')) throw new BadRequest('Send the file as multipart/form-data (field "file")');
	const length = request.headers.get('content-length');
	if (!length || !/^\d+$/.test(length)) return json({ message: 'Content-Length required (OctoPrint needs it for uploads)' }, { status: 411 });
	if (!request.body) throw new BadRequest('Empty upload');

	const q = url.searchParams;
	const origin = q.get('origin') === 'sdcard' ? 'sdcard' : 'local';
	const path = (q.get('path') ?? '').replace(/^\/+|\/+$/g, '');
	if (path.split('/').includes('..')) throw new BadRequest('Bad folder');
	const flag = (k: string) => q.get(k) === '1' || q.get(k) === 'true';
	const forward = new URLSearchParams();
	if (path) forward.set('path', path);
	if (flag('select') || flag('print')) forward.set('select', 'true');
	if (flag('print')) forward.set('print', 'true');

	let res: { status: number; text: string };
	try {
		res = await streamRequest(client.url(`/api/files/${origin}${forward.size ? `?${forward}` : ''}`), {
			method: 'POST',
			headers: { 'X-Api-Key': client.target.apiKey, accept: 'application/json', 'content-type': type, 'content-length': length },
			body: request.body,
			verifyTls: client.target.verifyTls,
			// The browser leaving aborts it; a stalled transfer times out after 5 idle minutes.
			signal: request.signal,
			timeoutMs: 5 * 60_000
		});
	} catch (err) {
		throw toOctoPrintError(err, client.host);
	}
	if (res.status < 200 || res.status >= 300) throw httpError(res.status, `/api/files/${origin}`, res.text);
	const result = (JSON.parse(res.text || '{}') ?? {}) as { done?: boolean; effectiveSelect?: boolean; effectivePrint?: boolean; files?: Record<string, { name?: string; path?: string }> };
	const stored = result.files?.[origin];
	const name = stored?.path ?? q.get('name') ?? 'file';
	audit(locals, 'file.upload', {
		printer,
		detail: `${origin === 'sdcard' ? 'SD: ' : ''}${name} (${bytesLabel(Number(length))})${flag('print') ? (result.effectivePrint ? ', printing' : ', print requested but the printer wasn’t ready') : ''}`
	});
	if (result.effectivePrint) audit(locals, 'job.start', { printer, detail: name });
	refreshSoon(printer.id);
	return json({ ok: true, origin, path: stored?.path ?? null, selected: !!result.effectiveSelect, printing: !!result.effectivePrint }, { status: 201 });
});
