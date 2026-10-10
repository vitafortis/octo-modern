import { handler } from '#lib/server/http.ts';
import { historyScope, parseFilter } from '#lib/server/history/access.ts';
import { listPrints } from '#lib/server/history/store.ts';
import { toCsv } from '#lib/server/history/stats.ts';
import type { RequestHandler } from './$types';

/** The (filtered) history as CSV, for spreadsheets. */
export const GET: RequestHandler = handler(({ locals, url }) => {
	const items = listPrints({ ...parseFilter(url), printerIds: historyScope(locals.user), limit: 100_000 });
	const name = `print-history-${new Date().toISOString().slice(0, 10)}.csv`;
	return new Response(toCsv(items), {
		headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' }
	});
});
