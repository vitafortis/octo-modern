import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { pushState, pushUser } from '#lib/server/push/api.ts';
import { parseSubscription, saveSubscription, SubscriptionError, toDevice } from '#lib/server/push/subscriptions.ts';
import { vapidKeys } from '#lib/server/push/vapid.ts';
import { deviceLabel } from '#lib/push.ts';
import type { RequestHandler } from './$types';

/**
 * Turns notifications on for this device: `{ subscription }` as `PushSubscription.toJSON()`
 * gives it. The same device again (same endpoint) refreshes its keys and owner.
 */
export const POST: RequestHandler = handler(async ({ locals, request }) => {
	const user = pushUser(locals);
	const b = await body(request);
	try {
		const sub = parseSubscription(b.subscription);
		const saved = saveSubscription(user.id, sub, { label: deviceLabel(request.headers.get('user-agent')), vapidKey: vapidKeys().publicKey });
		audit(locals, 'push.subscribe', { detail: saved.label });
		return json({ device: toDevice(saved), state: pushState(user) }, { status: 201 });
	} catch (err) {
		if (err instanceof SubscriptionError) throw new BadRequest(err.message);
		throw err;
	}
});
