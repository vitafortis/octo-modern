import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { requireAdmin } from '#lib/server/power/api.ts';
import { octoprintClient } from '#lib/server/backend/index.ts';
import { checkUpdates } from '#lib/server/plugins.ts';
import type { RequestHandler } from './$types';

/**
 * OctoPrint's Software Update check: `{ status, octoprint, targets, checkedAt, environmentSupported,
 * storageSufficient }`. `?force=1` makes OctoPrint ask upstream now ("Check now"). Admins only.
 */
export const GET: RequestHandler = handler(async ({ locals, params, url }) => {
	requireAdmin(locals.user);
	const printer = requirePrinter(locals.user, params.id);
	octoprintClient(printer, 'Plugins & updates');
	return json(await checkUpdates(printer, url.searchParams.has('force')), { headers: { 'cache-control': 'no-store' } });
});
