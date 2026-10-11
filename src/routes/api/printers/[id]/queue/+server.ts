import { json } from '@sveltejs/kit';
import { BadRequest, body, Forbidden, handler } from '#lib/server/http.ts';
import { audit, requireControl, requirePrinter } from '#lib/server/permissions.ts';
import { dispatcher } from '#lib/server/queue/dispatcher.ts';
import { setHeld, setPrinterTags } from '#lib/server/queue/store.ts';
import { confirmBedClear, queueState } from '#lib/server/queue/service.ts';
import { parseTags } from '#lib/queue.ts';
import type { RequestHandler } from './$types';

/** This printer's queue state and the jobs that could run on it. */
export const GET: RequestHandler = handler(({ locals, params }) => {
	const printer = requirePrinter(locals.user, params.id);
	const s = queueState(locals.user);
	return json({ paused: s.paused, printer: s.printers.find((p) => p.printerId === printer.id) ?? null, jobs: s.jobs }, { headers: { 'cache-control': 'no-store' } });
});

/**
 * `{ action: 'bed-clear' }` confirms the bed is clear; `'hold'` / `'release'` pause or
 * resume dispatch to this printer; `{ action: 'tags', tags }` sets its tags (admins).
 */
export const POST: RequestHandler = handler(async ({ locals, params, request }) => {
	const printer = requireControl(locals.user, params.id);
	const b = await body(request);
	switch (b.action) {
		case 'bed-clear': {
			const r = confirmBedClear(locals, printer.id);
			if (!r.ok) return json({ message: r.message }, { status: 409 });
			break;
		}
		case 'hold':
			setHeld(printer.id, true, 'Paused by hand');
			audit(locals, 'queue.hold', { printer });
			break;
		case 'release':
			setHeld(printer.id, false);
			audit(locals, 'queue.release', { printer });
			dispatcher.kick();
			break;
		case 'tags': {
			if (locals.user?.role !== 'admin') throw new Forbidden('Only admins change printer tags');
			const tags = parseTags(b.tags);
			setPrinterTags(printer.id, tags);
			audit(locals, 'queue.tags', { printer, detail: tags.join(', ') || '(none)' });
			dispatcher.kick();
			break;
		}
		default:
			throw new BadRequest('Unknown action');
	}
	const s = queueState(locals.user);
	return json(s.printers.find((p) => p.printerId === printer.id) ?? null);
});
