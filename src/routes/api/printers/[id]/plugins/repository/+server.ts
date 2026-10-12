import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { requireAdmin } from '#lib/server/power/api.ts';
import { octoprintClient } from '#lib/server/backend/index.ts';
import { repository } from '#lib/server/plugins.ts';
import type { RequestHandler } from './$types';

/**
 * The official plugin repository as this OctoPrint sees it (with its compatibility verdicts):
 * `{ available, plugins }`. `?refresh=1` makes OctoPrint fetch it again. Admins only.
 */
export const GET: RequestHandler = handler(async ({ locals, params, url }) => {
	requireAdmin(locals.user);
	const printer = requirePrinter(locals.user, params.id);
	octoprintClient(printer, 'Plugins & updates');
	return json(await repository(printer, url.searchParams.has('refresh')), { headers: { 'cache-control': 'no-store' } });
});
