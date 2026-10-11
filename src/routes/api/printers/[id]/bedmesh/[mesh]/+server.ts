import { json } from '@sveltejs/kit';
import { handler, NotFound } from '#lib/server/http.ts';
import { audit, requireControl, requirePrinter } from '#lib/server/permissions.ts';
import { deleteMesh, driftSettings, getMesh, saveDriftSettings } from '#lib/server/bedmesh.ts';
import type { RequestHandler } from './$types';

function meshOf(printerId: string, raw: string) {
	const m = /^\d+$/.test(raw) ? getMesh(Number(raw)) : undefined;
	if (!m || m.printerId !== printerId) throw new NotFound('Mesh not found');
	return m;
}

/** One stored mesh with its grid and stats. */
export const GET: RequestHandler = handler(({ locals, params }) => {
	const printer = requirePrinter(locals.user, params.id);
	return json(meshOf(printer.id, params.mesh), { headers: { 'cache-control': 'no-store' } });
});

/** Deletes a stored mesh (a bad probe run). If it was the reference, the oldest one takes over. Operators. */
export const DELETE: RequestHandler = handler(({ locals, params }) => {
	const printer = requireControl(locals.user, params.id);
	const m = meshOf(printer.id, params.mesh);
	deleteMesh(m.id);
	const s = driftSettings(printer.id);
	if (s.referenceId === m.id) saveDriftSettings(printer.id, { ...s, referenceId: null });
	audit(locals, 'bedmesh.delete', { printer, detail: `mesh of ${m.createdAt} (flatness ${m.flatness.toFixed(3)} mm)` });
	return json({ ok: true });
});
