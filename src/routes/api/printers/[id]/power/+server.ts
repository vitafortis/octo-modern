import { json } from '@sveltejs/kit';
import { BadRequest, body, NotFound } from '#lib/server/http.ts';
import { requireControl, requirePrinter } from '#lib/server/permissions.ts';
import { power } from '#lib/server/power/service.ts';
import { powerHandler } from '#lib/server/power/api.ts';
import type { RequestHandler } from './$types';

/** The printer's smart plug: state, watts, auto power-off countdown (`{ plug: null }` without one). */
export const GET: RequestHandler = powerHandler(async ({ params, locals, url }) => {
	const printer = requirePrinter(locals.user, params.id);
	if (!power.has(printer.id)) return json({ plug: null });
	await power.refresh(printer.id, url.searchParams.has('fresh') ? 0 : undefined);
	return json({ plug: power.info(printer.id) }, { headers: { 'cache-control': 'no-store' } });
});

/**
 * `{ action: 'on' }`, `{ action: 'off', confirm?, confirmPrinting? }` or `{ action: 'keep_on' }`.
 * Turning off answers 409 `confirmRequired` with `confirmField` while the printer is hot
 * (`confirm`) or printing (`confirm`, then a second 409 for `confirmPrinting`).
 */
export const POST: RequestHandler = powerHandler(async ({ params, locals, request }) => {
	const printer = requireControl(locals.user, params.id);
	if (!power.has(printer.id)) throw new NotFound('No smart plug is set up for this printer');
	const b = await body(request);
	switch (b.action) {
		case 'on':
			await power.powerOn(printer.id, locals);
			break;
		case 'off': {
			const check = await power.offCheck(printer.id, { confirm: b.confirm === true, confirmPrinting: b.confirmPrinting === true });
			if (check.confirm) {
				const c = check.confirm;
				return json({ message: c.message, title: c.title, stage: c.stage, confirmRequired: true, confirmField: c.field }, { status: 409 });
			}
			await power.powerOff(printer.id, locals, { detail: check.overridden ?? undefined });
			break;
		}
		case 'keep_on':
			if (!power.keepOn(printer.id, locals)) throw new BadRequest('No auto power-off is counting down');
			break;
		default:
			throw new BadRequest('"action" must be on, off or keep_on');
	}
	return json({ ok: true, plug: power.info(printer.id) });
});
