import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit, requireControl, requirePrinter } from '#lib/server/permissions.ts';
import { addDefaultTasks, createTask, listLog, listTasks, parseTaskInput, type TaskInput } from '#lib/server/maintenance.ts';
import { DEFAULT_TASKS } from '#lib/spools.ts';
import type { RequestHandler } from './$types';

/** The printer's maintenance tasks and log: `{ tasks, log }`. */
export const GET: RequestHandler = handler(({ locals, params }) => {
	const printer = requirePrinter(locals.user, params.id);
	return json({ tasks: listTasks([printer.id]), log: listLog({ printerId: printer.id, limit: 100 }) }, { headers: { 'cache-control': 'no-store' } });
});

/**
 * Adds a task `{ name, metric: hours|filament|days, interval, notes?, lastDoneAt? }`, or the
 * recommended ones with `{ defaults: ['nozzle', …] | true, lastDoneAt? }`. Operators.
 */
export const POST: RequestHandler = handler(async ({ locals, params, request }) => {
	const printer = requireControl(locals.user, params.id);
	const b = await body(request);
	let input: Partial<TaskInput>;
	try {
		input = parseTaskInput(b.defaults !== undefined ? { name: 'x', metric: 'days', interval: 1, lastDoneAt: b.lastDoneAt } : b);
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	if (b.defaults !== undefined) {
		const keys = b.defaults === true ? undefined : Array.isArray(b.defaults) ? b.defaults.filter((k): k is string => DEFAULT_TASKS.some((d) => d.key === k)) : [];
		const added = addDefaultTasks(printer.id, keys, input.lastDoneAt ?? null);
		if (added.length) audit(locals, 'maintenance.task_add', { printer, detail: added.map((t) => t.name).join(', ') });
		return json({ added, tasks: listTasks([printer.id]) }, { status: 201 });
	}
	const task = createTask(printer.id, input as TaskInput);
	audit(locals, 'maintenance.task_add', { printer, detail: `${task.name} (every ${task.interval} ${task.metric})` });
	return json(task, { status: 201 });
});
