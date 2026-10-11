import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { backfillCosts } from '#lib/server/costs.ts';
import { confirmRequired } from '#lib/server/control.ts';
import { body } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/** Recomputes the cost of every finished print with today's prices (`confirm: true`). */
export const POST: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request).catch(() => ({}) as Record<string, unknown>);
	if (b.confirm !== true) return confirmRequired('Every finished print is costed again with today’s prices (prints costed from a Spoolman spool keep that spool’s price). Recalculate?');
	const changed = backfillCosts({ all: true });
	audit(locals, 'history.recost', { detail: `${changed} prints` });
	return json({ changed });
});
