import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { historyScope, parseFilter } from '#lib/server/history/access.ts';
import { countPrints, listPrints } from '#lib/server/history/store.ts';
import type { RequestHandler } from './$types';

/**
 * Print history, newest first: `?printer=&result=&from=YYYY-MM-DD&to=YYYY-MM-DD&q=&limit=&before=<id>`.
 * Answers `{ items, total }`.
 */
export const GET: RequestHandler = handler(({ locals, url }) => {
	const filter = { ...parseFilter(url), printerIds: historyScope(locals.user) };
	const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
	const before = Number(url.searchParams.get('before')) || undefined;
	return json({ items: listPrints({ ...filter, limit, before }), total: countPrints(filter) }, { headers: { 'cache-control': 'no-store' } });
});
