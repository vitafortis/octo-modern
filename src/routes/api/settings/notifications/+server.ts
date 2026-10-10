import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { listChannels, saveChannels } from '#lib/server/history/notify.ts';
import type { RequestHandler } from './$types';

/** Print notification channels (admins; secrets come back as hints only). */
export const GET: RequestHandler = handler(() => json({ channels: listChannels() }));

/** Replaces the channels: `{ channels: [{ id?, kind, name, enabled, on: [...], config, secrets }] }`; empty secrets keep the stored ones. */
export const PUT: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request);
	let channels;
	try {
		channels = saveChannels(b.channels, locals.origin ?? null);
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	audit(locals, 'settings.notifications', { detail: channels.map((c) => `${c.name} (${c.kind})`).join(', ') || 'none' });
	return json({ channels });
});
