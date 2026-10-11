import { json } from '@sveltejs/kit';
import { handler, NotFound } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { pushUser } from '#lib/server/push/api.ts';
import { getSubscription } from '#lib/server/push/subscriptions.ts';
import { sendTo } from '#lib/server/push/deliver.ts';
import { load, publicUrlOf } from '#lib/server/notify/settings.ts';
import { testMessage } from '#lib/server/notify/render.ts';
import type { RequestHandler } from './$types';

/** Sends a test notification to one of your own devices. 502 with the push service's answer on failure. */
export const POST: RequestHandler = handler(async ({ locals, params }) => {
	const user = pushUser(locals);
	const sub = getSubscription(params.id);
	if (!sub || sub.userId !== user.id) throw new NotFound('No such device');
	const publicUrl = publicUrlOf(load());
	const m = testMessage(publicUrl, sub.label);
	m.text = `Notifications reach ${sub.label}.`;
	const t0 = Date.now();
	const r = await sendTo([sub], m, { publicUrl });
	const ms = Date.now() - t0;
	const error = r.gone ? 'The push service says this device unsubscribed; it was removed. Turn notifications on again.' : r.failed ? r.errors[0] : null;
	audit(locals, 'push.test', { detail: `${sub.label}: ${error ? `failed: ${error}` : 'ok'}`.slice(0, 300) });
	if (error) return json({ ok: false, message: error, gone: r.gone > 0 }, { status: 502 });
	return json({ ok: true, ms });
});
