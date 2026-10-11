import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { listSpools, spoolmanConfigured } from '#lib/server/spools/spoolman.ts';
import { allAssignments } from '#lib/server/spools/assignments.ts';
import { visiblePrinters } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

/**
 * Spoolman's spools (not archived), for picking the active one: `{ configured, spools, error, inUse }`.
 * `inUse` maps spool ids to the visible printer and tool they're on.
 */
export const GET: RequestHandler = handler(async ({ locals, url }) => {
	if (!spoolmanConfigured()) return json({ configured: false, spools: [], error: null, inUse: {} });
	const visible = new Map(visiblePrinters(locals.user).map((p) => [p.id, p.name]));
	const inUse: Record<number, { printerId: string; printerName: string; tool: number }> = {};
	for (const a of allAssignments()) if (visible.has(a.printerId)) inUse[a.spoolId] = { printerId: a.printerId, printerName: visible.get(a.printerId)!, tool: a.tool };
	try {
		const spools = await listSpools({ fresh: url.searchParams.has('fresh') });
		return json({ configured: true, spools, error: null, inUse }, { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return json({ configured: true, spools: [], error: (err as Error).message, inUse });
	}
});
