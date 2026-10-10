import { json } from '@sveltejs/kit';
import { handler, NotFound } from '#lib/server/http.ts';
import { abortSend, getSend } from '#lib/server/library/send.ts';
import type { RequestHandler } from './$types';

/** A transfer's progress. */
export const GET: RequestHandler = handler(async ({ locals, params }) => {
	const send = getSend(locals.user, params.id);
	if (!send) throw new NotFound('Transfer not found');
	return json(send, { headers: { 'cache-control': 'no-store' } });
});

/** Cancels a running transfer. */
export const DELETE: RequestHandler = handler(async ({ locals, params }) => {
	if (!abortSend(locals.user, params.id)) throw new NotFound('Transfer not found');
	return json({ ok: true });
});
