import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { visiblePrinters } from '#lib/server/permissions.ts';
import { listLog, listTasks } from '#lib/server/maintenance.ts';
import type { RequestHandler } from './$types';

/** Maintenance tasks and the latest log entries of every printer the user can see: `{ tasks, log, overdue, due }`. */
export const GET: RequestHandler = handler(({ locals, url }) => {
	const ids = visiblePrinters(locals.user).map((p) => p.id);
	const tasks = listTasks(ids);
	const log = listLog({ printerIds: ids, limit: Math.min(Number(url.searchParams.get('limit')) || 50, 500) });
	return json(
		{ tasks, log, overdue: tasks.filter((t) => t.status === 'overdue').length, due: tasks.filter((t) => t.status === 'due').length },
		{ headers: { 'cache-control': 'no-store' } }
	);
});
