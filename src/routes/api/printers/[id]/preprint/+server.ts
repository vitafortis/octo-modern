import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { controlTarget, viewTarget } from '#lib/server/control.ts';
import { prep } from '#lib/server/preprint/service.ts';
import type { RequestHandler } from './$types';

/**
 * The preparation running on the printer (`active`), and with `?path=` (and
 * `origin=sdcard`), what would run before printing that file (`plan`; operators).
 */
export const GET: RequestHandler = handler(async ({ params, locals, url }) => {
	const path = (url.searchParams.get('path') ?? '').replace(/^\/+/, '');
	if (!path) {
		const { printer } = viewTarget(locals.user, params.id);
		return json({ active: prep.active(printer.id) });
	}
	if (path.split('/').includes('..')) throw new BadRequest('Bad path');
	const { printer, backend } = controlTarget(locals.user, params.id);
	const origin = url.searchParams.get('origin') === 'sdcard' ? 'sdcard' : 'local';
	return json({ active: prep.active(printer.id), plan: await prep.plan(printer, backend, origin, path) });
});

/** Cancels the preparation: the steps stop being waited for and the file isn't started. */
export const DELETE: RequestHandler = handler(({ params, locals }) => {
	const { printer } = controlTarget(locals.user, params.id);
	// The service records the cancellation (and who) when the preparation stops.
	if (!prep.cancel(printer.id, locals)) return json({ ok: false, message: 'Nothing is being prepared on this printer' }, { status: 409 });
	return json({ ok: true });
});
