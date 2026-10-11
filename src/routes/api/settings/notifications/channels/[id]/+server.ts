import { json } from '@sveltejs/kit';
import { BadRequest, body, handler, NotFound } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { deleteChannel, load, SettingsError, updateChannel } from '#lib/server/notify/settings.ts';
import type { RequestHandler } from './$types';

/** Updates a channel; secrets left empty keep the stored ones, `clear: [field]` removes them. */
export const PUT: RequestHandler = handler(async ({ locals, params, request }) => {
	const b = await body(request);
	try {
		const channel = updateChannel(params.id, b);
		if (!channel) throw new NotFound('No such channel');
		audit(locals, 'notifications.channel.update', { detail: `${channel.name} (${channel.type})` });
		return json({ channel });
	} catch (err) {
		if (err instanceof SettingsError) throw new BadRequest(err.message);
		throw err;
	}
});

/** Removes a channel (and it from every rule). Needs `?confirm=1` when rules use it. */
export const DELETE: RequestHandler = handler(({ locals, params, url }) => {
	const s = load();
	const c = s.channels.find((x) => x.id === params.id);
	if (!c) throw new NotFound('No such channel');
	const used = s.rules.filter((r) => r.channels.includes(c.id));
	if (used.length && url.searchParams.get('confirm') !== '1') {
		return json({ message: `${c.name} is used by ${used.length} rule${used.length === 1 ? '' : 's'} (${used.map((r) => r.name).join(', ')}); it will be removed from them.`, confirmRequired: true }, { status: 409 });
	}
	deleteChannel(c.id);
	audit(locals, 'notifications.channel.delete', { detail: `${c.name} (${c.type})` });
	return json({ ok: true });
});
