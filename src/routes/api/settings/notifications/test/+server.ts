import { json } from '@sveltejs/kit';
import { body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { testChannel } from '#lib/server/notify/service.ts';
import type { RequestHandler } from './$types';

/**
 * Sends a test message: `{ id }` through a saved channel, or `{ id?, channel }` through
 * the editor's unsaved settings (stored secrets of `id` fill in empty ones). Answers
 * `{ ok: true, ms }` or 502 `{ ok: false, message }` with the service's exact answer.
 */
export const POST: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request);
	const id = typeof b.id === 'string' && b.id ? b.id : null;
	try {
		const r = await testChannel(id, b.channel);
		audit(locals, 'notifications.test', { detail: `ok${id ? '' : ' (unsaved)'}` });
		return json({ ok: true, ...r });
	} catch (err) {
		audit(locals, 'notifications.test', { detail: `failed: ${(err as Error).message}`.slice(0, 300) });
		return json({ ok: false, message: (err as Error).message }, { status: 502 });
	}
});
