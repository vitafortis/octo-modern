import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit, requireControl, requirePrinter } from '#lib/server/permissions.ts';
import { assignSpool, printerSpools } from '#lib/server/spools/assignments.ts';
import { getSpool, spoolmanConfigured } from '#lib/server/spools/spoolman.ts';
import { checkLow } from '#lib/server/spools/usage.ts';
import type { RequestHandler } from './$types';

/** The printer's active spools per tool, with Spoolman's details. */
export const GET: RequestHandler = handler(async ({ locals, params }) => {
	const printer = requirePrinter(locals.user, params.id);
	return json(await printerSpools(printer.id), { headers: { 'cache-control': 'no-store' } });
});

/** Sets a tool's active spool: `{ tool, spoolId }` (`spoolId: null` takes it off). Operators. */
export const PUT: RequestHandler = handler(async ({ locals, params, request }) => {
	const printer = requireControl(locals.user, params.id);
	const b = await body(request);
	const tool = Number(b.tool ?? 0);
	if (!Number.isInteger(tool) || tool < 0 || tool > 15) throw new BadRequest('"tool" must be a tool number (0–15)');
	if (b.spoolId === null) {
		assignSpool(printer.id, tool, null, null);
		audit(locals, 'spool.unassign', { printer, detail: `tool ${tool}` });
		return json(await printerSpools(printer.id));
	}
	const spoolId = Number(b.spoolId);
	if (!Number.isInteger(spoolId) || spoolId <= 0) throw new BadRequest('"spoolId" must be a Spoolman spool id');
	if (!spoolmanConfigured()) throw new BadRequest('Spoolman isn’t set up yet (Filament page, as an admin)');
	const spool = await getSpool(spoolId, { fresh: true });
	if (!spool) throw new BadRequest(`Spoolman has no spool #${spoolId}`);
	if (spool.archived) throw new BadRequest(`Spool #${spoolId} is archived in Spoolman`);
	assignSpool(printer.id, tool, spoolId, locals.user?.name ?? locals.user?.email ?? null);
	audit(locals, 'spool.assign', { printer, detail: `tool ${tool}: #${spool.id} ${spool.name}${spool.material ? ` (${spool.material})` : ''}` });
	await checkLow(spool, printer.id).catch(() => {});
	return json(await printerSpools(printer.id));
});
