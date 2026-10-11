import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { backfillCosts, costSettings, saveCostSettings } from '#lib/server/costs.ts';
import { listPrinters } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** Cost settings (admins). */
export const GET: RequestHandler = handler(() => json(costSettings()));

/** Saves the cost settings, then costs history entries that have no cost yet. */
export const PUT: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request);
	let s;
	try {
		s = saveCostSettings(b, listPrinters().map((p) => p.id));
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	const costed = backfillCosts();
	audit(locals, 'settings.costs', { detail: `${s.currency}, ${s.electricityPerKwh ?? '—'}/kWh, ${s.materials.length} materials` });
	return json({ ...s, costed });
});
