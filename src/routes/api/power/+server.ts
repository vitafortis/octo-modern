import { json } from '@sveltejs/kit';
import { visiblePrinters } from '#lib/server/permissions.ts';
import { power } from '#lib/server/power/service.ts';
import type { RequestHandler } from './$types';

/** Smart plug state of every printer the user can see that has one (sidebar and overview poll this). */
export const GET: RequestHandler = async ({ locals }) => {
	const ids = visiblePrinters(locals.user).map((p) => p.id);
	return json(await power.infos(ids), { headers: { 'cache-control': 'no-store' } });
};
