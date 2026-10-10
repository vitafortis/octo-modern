import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import type { RequestHandler } from './$types';

/**
 * The printer's current snapshot, temperature history (`?since=<epoch ms>` limits it)
 * and recent terminal lines — what the event stream sends first, as plain JSON.
 */
export const GET: RequestHandler = handler(async ({ params, locals, url }) => {
	const p = requirePrinter(locals.user, params.id);
	await printers.snapshots([p.id]);
	const model = printers.model(p.id)!;
	const since = Number(url.searchParams.get('since')) || undefined;
	return json(
		{ snapshot: model.snapshot, history: model.history.since(since), logs: model.logs, busyFiles: model.busyFiles, push: printers.pushState(p.id) },
		{ headers: { 'cache-control': 'no-store' } }
	);
});
