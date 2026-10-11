import { json } from '@sveltejs/kit';
import { Forbidden, body, handler } from '#lib/server/http.ts';
import { audit, requirePrinter, visiblePrinters } from '#lib/server/permissions.ts';
import { importHistory } from '#lib/server/history/import.ts';
import { toOctoPrintError } from '#lib/server/octoprint/errors.ts';
import type { RequestHandler } from './$types';

/**
 * Imports earlier prints from OctoPrint (the PrintJobHistory plugin, or each file's
 * last-print statistics) or Klipper (Moonraker's job history), for one printer (`{ printer }`) or all. Admins only.
 */
export const POST: RequestHandler = handler(async ({ locals, request }) => {
	if (locals.user?.role !== 'admin') throw new Forbidden('Only admins can import history');
	const b = await body(request).catch(() => ({}) as Record<string, unknown>);
	const targets = typeof b.printer === 'string' ? [requirePrinter(locals.user, b.printer)] : visiblePrinters(locals.user);
	const results = await Promise.all(
		targets.map(async (p) => {
			try {
				return { printerId: p.id, name: p.name, ...(await importHistory(p)) };
			} catch (err) {
				return { printerId: p.id, name: p.name, imported: 0, skipped: 0, sources: [], error: toOctoPrintError(err).message };
			}
		})
	);
	const imported = results.reduce((n, r) => n + r.imported, 0);
	audit(locals, 'history.import', { detail: `${imported} prints from ${results.length} printer${results.length === 1 ? '' : 's'}` });
	return json({ imported, results });
});
