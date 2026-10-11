import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { generalOf, listChannels, load, saveSettings, SettingsError } from '#lib/server/notify/settings.ts';
import { bridge } from '#lib/server/notify/bridge.ts';
import type { RequestHandler } from './$types';

/** Notification settings (admins): channels (secrets as hints only), rules and the general options. */
export const GET: RequestHandler = handler(({ locals }) => {
	const s = load();
	return json({ general: generalOf(s), channels: listChannels(), rules: s.rules, seenUrl: locals.origin ?? null, envOrigin: process.env.ORIGIN ?? null });
});

/** Saves the general options and/or `rules` (channels have their own routes). */
export const PUT: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request);
	let s;
	try {
		s = saveSettings(b);
	} catch (err) {
		if (err instanceof SettingsError) throw new BadRequest(err.message);
		throw err;
	}
	bridge.invalidate();
	audit(locals, 'settings.notifications', { detail: `${s.rules.length} rules${'rules' in b ? '' : ' (options)'}` });
	return json({ general: generalOf(s), channels: listChannels(), rules: s.rules });
});
