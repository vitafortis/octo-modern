import { json } from '@sveltejs/kit';
import { body, handler } from '#lib/server/http.ts';
import { testChannel } from '#lib/server/history/notify.ts';
import type { RequestHandler } from './$types';

/** Sends a test message through a saved channel: `{ id }`. */
export const POST: RequestHandler = handler(async ({ request }) => {
	const b = await body(request);
	try {
		await testChannel(String(b.id ?? ''));
		return json({ ok: true });
	} catch (err) {
		return json({ ok: false, message: (err as Error).message }, { status: 502 });
	}
});
