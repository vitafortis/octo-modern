import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { getPrinter } from '#lib/server/store.ts';
import { addLibraryJob, addPrinterFileJob, queueState } from '#lib/server/queue/service.ts';
import type { RequestHandler } from './$types';

/** The queue: jobs and printer states the user can see, and whether it's paused. */
export const GET: RequestHandler = handler(({ locals }) => json(queueState(locals.user), { headers: { 'cache-control': 'no-store' } }));

/**
 * Adds a job: `{ source: 'library', sourceId, path }` or `{ source: 'printer', printerId, path }`,
 * with `printerId` (null = any compatible printer), `tags` (for any printer) and `copies`.
 * Uploads go to /api/queue/upload.
 */
export const POST: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request);
	const job = b.source === 'library' ? await addLibraryJob(locals.user, b) : b.source === 'printer' ? await addPrinterFileJob(locals.user, b) : null;
	if (!job) throw new BadRequest('"source" must be "library" or "printer"');
	const printer = job.printerId ? getPrinter(job.printerId) : undefined;
	audit(locals, 'queue.add', {
		printer,
		detail: `${job.name}${job.copies > 1 ? ` ×${job.copies}` : ''} → ${printer ? printer.name : `any printer${job.tags.length ? ` with ${job.tags.join(', ')}` : ''}`}`
	});
	return json(job, { status: 201 });
});
