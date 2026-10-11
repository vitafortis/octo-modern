import { json } from '@sveltejs/kit';
import { body } from '#lib/server/http.ts';
import { audit, requirePrinter } from '#lib/server/permissions.ts';
import { power } from '#lib/server/power/service.ts';
import { powerHandler, requireAdmin } from '#lib/server/power/api.ts';
import { configView, deletePlug, describePlug, getPlug, parsePlugInput, savePlug } from '#lib/server/power/config.ts';
import type { RequestHandler } from './$types';

/** The plug's setup for admins: addresses and settings, secrets only as hints. */
export const GET: RequestHandler = powerHandler(async ({ params, locals }) => {
	requireAdmin(locals.user);
	const printer = requirePrinter(locals.user, params.id);
	const plug = getPlug(printer.id);
	return json({ plug: plug ? configView(plug) : null });
});

/** Saves the plug: `{ kind, label?, config, secrets?, clearSecrets?, settings }`; empty secret fields keep the stored ones. */
export const PUT: RequestHandler = powerHandler(async ({ params, locals, request }) => {
	requireAdmin(locals.user);
	const printer = requirePrinter(locals.user, params.id);
	const prev = getPlug(printer.id);
	const input = parsePlugInput(await body(request), prev);
	const saved = savePlug(printer.id, input);
	power.invalidate(printer.id);
	const s = saved.settings;
	audit(locals, prev ? 'power.config.update' : 'power.config.create', {
		printer,
		detail: `${describePlug(saved)}; auto-connect ${s.autoConnect ? 'on' : 'off'}, auto power-on ${s.autoOn ? 'on' : 'off'}, auto power-off ${s.autoOff.enabled ? `after ${s.autoOff.idleMinutes} min below ${s.autoOff.hotendC} °C` : 'off'}`
	});
	return json({ plug: configView(saved) });
});

export const DELETE: RequestHandler = powerHandler(async ({ params, locals }) => {
	requireAdmin(locals.user);
	const printer = requirePrinter(locals.user, params.id);
	const prev = getPlug(printer.id);
	if (deletePlug(printer.id)) audit(locals, 'power.config.delete', { printer, detail: prev ? describePlug(prev) : undefined });
	power.invalidate(printer.id);
	return json({ ok: true });
});
