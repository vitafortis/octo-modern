import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { requireAdmin } from '#lib/server/power/api.ts';
import { opState } from '#lib/server/plugins.ts';
import type { RequestHandler } from './$types';

/** The running plugin action (install, update, restart…) with its live log, or the last one's outcome: `{ op }`. Admins only. */
export const GET: RequestHandler = handler(async ({ locals, params }) => {
	requireAdmin(locals.user);
	const printer = requirePrinter(locals.user, params.id);
	return json({ op: opState(printer.id) }, { headers: { 'cache-control': 'no-store' } });
});
