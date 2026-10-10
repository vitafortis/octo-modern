import { json } from '@sveltejs/kit';
import { BadRequest, Forbidden, body, handler } from '#lib/server/http.ts';
import { audit, canControl } from '#lib/server/permissions.ts';
import { requireEntry } from '#lib/server/history/access.ts';
import { deletePrint, getPrint, updatePrint } from '#lib/server/history/store.ts';
import { getPrinter } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(({ locals, params }) => json(requireEntry(locals.user, params.entry)));

/** Notes on a print (operators and admins of its printer): `{ notes }`. */
export const PATCH: RequestHandler = handler(async ({ locals, params, request }) => {
	const r = requireEntry(locals.user, params.entry);
	const printer = getPrinter(r.printerId);
	if (locals.user?.role !== 'admin' && !(printer && canControl(locals.user, printer))) throw new Forbidden('Your role can only view the history');
	const b = await body(request);
	if (typeof b.notes !== 'string' && b.notes !== null) throw new BadRequest('"notes" must be text');
	const notes = typeof b.notes === 'string' ? b.notes.trim().slice(0, 4000) || null : null;
	updatePrint(r.id, { notes });
	return json(getPrint(r.id));
});

/** Removes an entry (admins). */
export const DELETE: RequestHandler = handler(({ locals, params }) => {
	if (locals.user?.role !== 'admin') throw new Forbidden('Only admins can delete history entries');
	const r = requireEntry(locals.user, params.entry);
	deletePrint(r.id);
	audit(locals, 'history.delete', { printer: { id: r.printerId, name: r.printerName }, detail: `${r.file} (${r.startedAt})` });
	return json({ ok: true });
});
