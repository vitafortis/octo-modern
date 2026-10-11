import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { createChannel, listChannels, SettingsError } from '#lib/server/notify/settings.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(() => json({ channels: listChannels() }));

/** Adds a channel: `{ type, name, enabled, config, secrets, quiet }`. */
export const POST: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request);
	try {
		const channel = createChannel(b);
		audit(locals, 'notifications.channel.create', { detail: `${channel.name} (${channel.type})` });
		return json({ channel }, { status: 201 });
	} catch (err) {
		if (err instanceof SettingsError) throw new BadRequest(err.message);
		throw err;
	}
});
