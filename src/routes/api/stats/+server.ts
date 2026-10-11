import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { statsQuery } from '#lib/server/history/stats-access.ts';
import { statsReport } from '#lib/server/history/report.ts';
import type { RequestHandler } from './$types';

/**
 * `GET /api/stats?range=30d|90d|12m|all&printer=<id>&tz=<IANA zone>`: the Stats page's
 * numbers for the printers the user can see (admins: removed printers too).
 */
export const GET: RequestHandler = handler(async ({ locals, url }) =>
	json(await statsReport(statsQuery(locals.user, url)), { headers: { 'cache-control': 'no-store' } })
);
