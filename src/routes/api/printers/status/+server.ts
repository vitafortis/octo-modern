import { json } from '@sveltejs/kit';
import { visiblePrinters } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import type { RequestHandler } from './$types';

/**
 * Live snapshots of every printer the user can see (sidebar and overview poll this).
 * Served from memory; printers nobody watches are refreshed by the status poll.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const ids = visiblePrinters(locals.user).map((p) => p.id);
	return json(await printers.snapshots(ids), { headers: { 'cache-control': 'no-store' } });
};
