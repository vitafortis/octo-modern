import { json } from '@sveltejs/kit';
import { body, handler } from '#lib/server/http.ts';
import { addQueueJob, queueState } from '#lib/server/queue/service.ts';
import type { RequestHandler } from './$types';

/** The queue: jobs and printer states the user can see, and whether it's paused. */
export const GET: RequestHandler = handler(({ locals }) => json(queueState(locals.user), { headers: { 'cache-control': 'no-store' } }));

/**
 * Adds a job: `{ source: 'library', sourceId, path }` or `{ source: 'printer', printerId, path }`,
 * with `printerId` (null = any compatible printer), `tags` (for any printer) and `copies`.
 * Uploads go to /api/queue/upload.
 */
export const POST: RequestHandler = handler(async ({ locals, request }) => json(await addQueueJob(locals, await body(request)), { status: 201 }));
