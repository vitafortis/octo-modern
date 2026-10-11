import { json } from '@sveltejs/kit';
import { handler, NotFound } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { pushState, pushUser } from '#lib/server/push/api.ts';
import { deleteSubscription, getSubscription } from '#lib/server/push/subscriptions.ts';
import type { RequestHandler } from './$types';

/** Removes one of your own devices (others' don't exist, as far as you can tell). */
export const DELETE: RequestHandler = handler(({ locals, params }) => {
	const user = pushUser(locals);
	const sub = getSubscription(params.id);
	if (!sub || sub.userId !== user.id || !deleteSubscription(params.id, user.id)) throw new NotFound('No such device');
	audit(locals, 'push.unsubscribe', { detail: sub.label });
	return json({ ok: true, state: pushState(user) });
});
