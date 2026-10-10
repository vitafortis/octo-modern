import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { searchAudit } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** Admins: audit events, newest first, filtered and paged with `before`. */
export const GET: RequestHandler = handler(({ url }) => {
	const p = url.searchParams;
	return json(
		searchAudit({
			userId: p.get('user') || undefined,
			printerId: p.get('printer') || undefined,
			action: p.get('action') || undefined,
			q: p.get('q')?.trim() || undefined,
			before: Number(p.get('before')) || undefined,
			limit: Number(p.get('limit')) || 100
		})
	);
});
