import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { historyScope, parseFilter } from '#lib/server/history/access.ts';
import { listPrints } from '#lib/server/history/store.ts';
import { aggregate } from '#lib/server/history/stats.ts';
import { costSettings } from '#lib/server/costs.ts';
import type { RequestHandler } from './$types';

/** Totals for the same filters as /api/history: success rate, print time, filament, per printer and per week. */
export const GET: RequestHandler = handler(({ locals, url }) => {
	const items = listPrints({ ...parseFilter(url), printerIds: historyScope(locals.user), limit: 100_000 });
	return json({ ...aggregate(items), currency: costSettings().currency }, { headers: { 'cache-control': 'no-store' } });
});
