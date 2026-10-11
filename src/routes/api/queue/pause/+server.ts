import { json } from '@sveltejs/kit';
import { body, Forbidden, handler } from '#lib/server/http.ts';
import { roleAllows } from '#lib/server/access.ts';
import { audit } from '#lib/server/permissions.ts';
import { setPaused } from '#lib/server/queue/store.ts';
import { dispatcher } from '#lib/server/queue/dispatcher.ts';
import type { RequestHandler } from './$types';

/** Pauses or resumes the whole queue: `{ paused: true|false }`. Running prints carry on. */
export const POST: RequestHandler = handler(async ({ locals, request }) => {
	if (!roleAllows(locals.user?.role, 'control')) throw new Forbidden('Your role can only watch the queue');
	const paused = (await body(request)).paused === true;
	setPaused(paused);
	audit(locals, paused ? 'queue.pause' : 'queue.resume');
	if (!paused) dispatcher.kick();
	return json({ paused });
});
