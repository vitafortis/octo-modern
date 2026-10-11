import { json } from '@sveltejs/kit';
import { body, handler, NotFound } from '#lib/server/http.ts';
import { audit, requireControl } from '#lib/server/permissions.ts';
import { getTask, markDone } from '#lib/server/maintenance.ts';
import { usageLabel } from '#lib/spools.ts';
import type { RequestHandler } from './$types';

/** Marks a task done now (`{ notes? }`): logs who and when, and restarts its count. Operators. */
export const POST: RequestHandler = handler(async ({ locals, params, request }) => {
	const printer = requireControl(locals.user, params.id);
	const task = getTask(params.task);
	if (!task || task.printerId !== printer.id) throw new NotFound('Maintenance task not found');
	const b = await body(request).catch(() => ({}) as Record<string, unknown>);
	const notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim().slice(0, 2000) : null;
	const entry = markDone(task, { userId: locals.user?.id ?? null, label: locals.user?.name ?? locals.user?.email ?? null }, notes);
	audit(locals, 'maintenance.done', { printer, detail: `${task.name} at ${usageLabel(task)}${notes ? `: ${notes.slice(0, 200)}` : ''}` });
	return json({ entry, task: getTask(task.id) });
});
