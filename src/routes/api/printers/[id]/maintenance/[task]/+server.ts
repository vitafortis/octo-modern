import { json } from '@sveltejs/kit';
import { BadRequest, body, handler, NotFound } from '#lib/server/http.ts';
import { confirmRequired } from '#lib/server/control.ts';
import { audit, requireControl } from '#lib/server/permissions.ts';
import { deleteTask, getTask, parseTaskInput, updateTask } from '#lib/server/maintenance.ts';
import type { Printer } from '#lib/types.ts';
import type { RequestHandler } from './$types';

function requireTask(printer: Printer, id: string) {
	const t = getTask(id);
	if (!t || t.printerId !== printer.id) throw new NotFound('Maintenance task not found');
	return t;
}

/** Edits a task: any of `{ name, metric, interval, notes, lastDoneAt }`. Operators. */
export const PATCH: RequestHandler = handler(async ({ locals, params, request }) => {
	const printer = requireControl(locals.user, params.id);
	const before = requireTask(printer, params.task);
	let patch;
	try {
		patch = parseTaskInput(await body(request), true);
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	const task = updateTask(before.id, patch)!;
	audit(locals, 'maintenance.task_edit', { printer, detail: `${task.name} (every ${task.interval} ${task.metric})` });
	return json(task);
});

/** Removes a task (its log stays). Needs `?confirm=1`. */
export const DELETE: RequestHandler = handler(({ locals, params, url }) => {
	const printer = requireControl(locals.user, params.id);
	const task = requireTask(printer, params.task);
	if (url.searchParams.get('confirm') !== '1') return confirmRequired(`Remove “${task.name}”? Its log entries stay.`);
	deleteTask(task.id);
	audit(locals, 'maintenance.task_delete', { printer, detail: task.name });
	return json({ ok: true });
});
