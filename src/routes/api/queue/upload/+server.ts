import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { getPrinter } from '#lib/server/store.ts';
import { bytesLabel } from '#lib/server/octoprint/files-util.ts';
import { boundaryOf, MultipartError, parseMultipart } from '#lib/server/multipart.ts';
import { tempUploadPath } from '#lib/server/queue/files.ts';
import { addUploadJob, parseTarget } from '#lib/server/queue/service.ts';
import { rm } from 'node:fs/promises';
import type { RequestHandler } from './$types';

/**
 * Queues an uploaded file (multipart, field `file`), kept by octo·modern until the job is
 * removed. Options in the query: `printerId`, `tags` (comma-separated), `copies`.
 */
export const POST: RequestHandler = handler(async ({ locals, request, url }) => {
	const q = url.searchParams;
	const t = parseTarget(locals.user, { printerId: q.get('printerId'), tags: q.get('tags') ?? '', copies: q.get('copies') ?? 1 });
	const boundary = boundaryOf(request.headers.get('content-type'));
	if (!boundary || !request.body) throw new BadRequest('Send the file as multipart/form-data (field "file")');
	const tmp = await tempUploadPath();
	let parsed;
	try {
		parsed = await parseMultipart(request.body as unknown as AsyncIterable<Uint8Array>, boundary, tmp);
	} catch (err) {
		throw new BadRequest(err instanceof MultipartError ? err.message : 'Couldn’t read the upload');
	}
	if (!parsed.file) {
		await rm(tmp, { force: true });
		throw new BadRequest('No file in the upload');
	}
	const user = locals.user!;
	const job = await addUploadJob({ tmpFile: tmp, filename: parsed.file.filename, size: parsed.file.size, ...t, createdById: user.id, createdBy: user.name || user.email });
	const printer = job.printerId ? getPrinter(job.printerId) : undefined;
	audit(locals, 'queue.add', { printer, detail: `${job.name} (upload, ${bytesLabel(parsed.file.size)})${job.copies > 1 ? ` ×${job.copies}` : ''} → ${printer ? printer.name : 'any printer'}` });
	return json(job, { status: 201 });
});
