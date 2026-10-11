import { json } from '@sveltejs/kit';
import { BadRequest, body, Forbidden, handler } from '#lib/server/http.ts';
import { roleAllows } from '#lib/server/access.ts';
import { audit } from '#lib/server/permissions.ts';
import { reorder } from '#lib/server/queue/store.ts';
import { dispatcher } from '#lib/server/queue/dispatcher.ts';
import { queueState } from '#lib/server/queue/service.ts';
import type { RequestHandler } from './$types';

/** Reorders the pending jobs: `{ ids: [...] }` in the new order (jobs left out keep their place after them). */
export const POST: RequestHandler = handler(async ({ locals, request }) => {
	if (!roleAllows(locals.user?.role, 'control')) throw new Forbidden('Your role can only watch the queue');
	const b = await body(request);
	if (!Array.isArray(b.ids) || b.ids.some((x) => typeof x !== 'string') || b.ids.length > 5000) throw new BadRequest('"ids" must be a list of job ids');
	// Jobs the user can't see keep their relative order: only visible ones are passed in.
	const visible = queueState(locals.user).jobs.map((j) => j.id);
	reorder((b.ids as string[]).filter((id) => visible.includes(id)));
	audit(locals, 'queue.reorder', { detail: `${b.ids.length} jobs` });
	dispatcher.kick();
	return json(queueState(locals.user));
});
