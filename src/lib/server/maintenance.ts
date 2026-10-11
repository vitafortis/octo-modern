/**
 * Maintenance reminders per printer: tasks with an interval in print hours, filament
 * (kg) or days, counted from the print history since the task was last done, a log of
 * who did what when, and a `maintenance.due` notification when a task falls overdue.
 */
import { randomUUID } from 'node:crypto';
import { getPrinter, listPrinters, sqlite } from './store.ts';
import { notifyEvent } from './history/notify.ts';
import { costSettings } from './costs.ts';
import { DEFAULT_TASKS, gramsFromMm, materialOf, maintenanceStatus, METRIC_UNIT, METRICS, usageLabel, type MaintenanceLogEntry, type MaintenanceMetric, type MaintenanceTask } from '#lib/spools.ts';

type Row = Record<string, unknown>;
const db = () => sqlite();

/** Usage of a printer since `since`, in each metric's unit. */
export function usageSince(printerId: string, since: string, now = Date.now()): Record<MaintenanceMetric, number> {
	const s = costSettings();
	const gPerMm = gramsFromMm(1, materialOf(s, s.defaultMaterial).density, s.diameter);
	const r = db()
		.prepare(
			`SELECT coalesce(sum(duration_s), 0) AS secs, coalesce(sum(coalesce(filament_g, filament_mm * ?)), 0) AS grams
			 FROM prints WHERE printer_id = ? AND started_at >= ? AND result IN ('success', 'failed', 'cancelled')`
		)
		.get(gPerMm, printerId, since) as Row;
	return {
		hours: Number(r.secs) / 3600,
		filament: Number(r.grams) / 1000,
		days: Math.max(0, (now - Date.parse(since)) / 86_400_000)
	};
}

function toTask(r: Row, cache: Map<string, Record<MaintenanceMetric, number>>): MaintenanceTask {
	const since = (r.last_done_at as string) ?? (r.created_at as string);
	const key = `${r.printer_id}|${since}`;
	let usage = cache.get(key);
	if (!usage) cache.set(key, (usage = usageSince(r.printer_id as string, since)));
	const metric = r.metric as MaintenanceMetric;
	const interval = Number(r.interval);
	const used = Math.round(usage[metric] * 1000) / 1000;
	return {
		id: r.id as string,
		printerId: r.printer_id as string,
		name: r.name as string,
		metric,
		interval,
		notes: (r.notes as string) ?? null,
		createdAt: r.created_at as string,
		lastDoneAt: (r.last_done_at as string) ?? null,
		lastDoneBy: (r.last_done_by as string) ?? null,
		used,
		progress: interval > 0 ? used / interval : 0,
		status: maintenanceStatus(used, interval)
	};
}

/** Tasks of the given printers (null: all), most urgent first within each printer. */
export function listTasks(printerIds: string[] | null): MaintenanceTask[] {
	if (printerIds && !printerIds.length) return [];
	const where = printerIds ? `WHERE printer_id IN (${printerIds.map(() => '?').join(',')})` : '';
	const rows = db().prepare(`SELECT * FROM maintenance_tasks ${where} ORDER BY sort, created_at`).all(...(printerIds ?? [])) as Row[];
	const cache = new Map();
	return rows.map((r) => toTask(r, cache)).sort((a, b) => a.printerId.localeCompare(b.printerId) || b.progress - a.progress);
}

export function getTask(id: string): MaintenanceTask | undefined {
	const r = db().prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(id) as Row | undefined;
	return r && toTask(r, new Map());
}

export function overdueCount(printerIds: string[] | null): number {
	return listTasks(printerIds).filter((t) => t.status === 'overdue').length;
}

export interface TaskInput {
	name: string;
	metric: MaintenanceMetric;
	interval: number;
	notes: string | null;
	/** When it was last done before octo·modern tracked it (counts history since then). */
	lastDoneAt?: string | null;
}

/** Validates a task form; throws with a message for the user. */
export function parseTaskInput(b: Record<string, unknown>, partial = false): Partial<TaskInput> {
	const out: Partial<TaskInput> = {};
	if (!partial || b.name !== undefined) {
		const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
		if (!name) throw new Error('Give the task a name');
		out.name = name;
	}
	if (!partial || b.metric !== undefined) {
		if (!METRICS.includes(b.metric as MaintenanceMetric)) throw new Error('"metric" must be hours, filament or days');
		out.metric = b.metric as MaintenanceMetric;
	}
	if (!partial || b.interval !== undefined) {
		const n = Number(b.interval);
		if (!Number.isFinite(n) || n <= 0 || n > 100_000) throw new Error('The interval must be a number above 0');
		out.interval = Math.round(n * 1000) / 1000;
	}
	if (b.notes !== undefined) out.notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim().slice(0, 1000) : null;
	if (b.lastDoneAt !== undefined && b.lastDoneAt !== null && b.lastDoneAt !== '') {
		const d = new Date(String(b.lastDoneAt));
		if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 60_000) throw new Error('“Last done” must be a date in the past');
		out.lastDoneAt = d.toISOString();
	}
	return out;
}

export function createTask(printerId: string, t: TaskInput): MaintenanceTask {
	const id = randomUUID();
	const sort = (db().prepare('SELECT coalesce(max(sort), 0) + 1 AS n FROM maintenance_tasks WHERE printer_id = ?').get(printerId) as Row).n as number;
	db()
		.prepare('INSERT INTO maintenance_tasks (id, printer_id, name, metric, interval, notes, sort, created_at, last_done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
		.run(id, printerId, t.name, t.metric, t.interval, t.notes ?? null, sort, new Date().toISOString(), t.lastDoneAt ?? null);
	return getTask(id)!;
}

/** Adds the default tasks with these keys (all when none given) that the printer doesn't have by name. */
export function addDefaultTasks(printerId: string, keys?: string[], lastDoneAt?: string | null): MaintenanceTask[] {
	const have = new Set(listTasks([printerId]).map((t) => t.name.toLowerCase()));
	return DEFAULT_TASKS.filter((d) => (!keys || keys.includes(d.key)) && !have.has(d.name.toLowerCase())).map((d) =>
		createTask(printerId, { name: d.name, metric: d.metric, interval: d.interval, notes: d.notes, lastDoneAt })
	);
}

export function updateTask(id: string, patch: Partial<TaskInput>): MaintenanceTask | undefined {
	const sets: string[] = [];
	const values: (string | number | null)[] = [];
	const cols: Record<string, string> = { name: 'name', metric: 'metric', interval: 'interval', notes: 'notes', lastDoneAt: 'last_done_at' };
	for (const [k, col] of Object.entries(cols)) {
		const v = patch[k as keyof TaskInput];
		if (v !== undefined) sets.push(`${col} = ?`), values.push(v as string | number | null);
	}
	// A changed interval or metric may make it due again: notify afresh.
	if (sets.length) db().prepare(`UPDATE maintenance_tasks SET ${sets.join(', ')}, notified_at = NULL WHERE id = ?`).run(...values, id);
	return getTask(id);
}

export function deleteTask(id: string): boolean {
	return Number(db().prepare('DELETE FROM maintenance_tasks WHERE id = ?').run(id).changes) > 0;
}

/** Marks a task done now: logs it with the usage it had reached, and restarts its count. */
export function markDone(task: MaintenanceTask, by: { userId: string | null; label: string | null }, notes: string | null): MaintenanceLogEntry {
	const h = db();
	const now = new Date().toISOString();
	const printer = getPrinter(task.printerId);
	h.exec('BEGIN');
	try {
		const r = h
			.prepare(
				`INSERT INTO maintenance_log (task_id, printer_id, printer_name, task_name, metric, interval, used, done_at, user_id, done_by, notes)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(task.id, task.printerId, printer?.name ?? task.printerId, task.name, task.metric, task.interval, task.used, now, by.userId, by.label, notes);
		h.prepare('UPDATE maintenance_tasks SET last_done_at = ?, last_done_by = ?, notified_at = NULL WHERE id = ?').run(now, by.label, task.id);
		h.exec('COMMIT');
		return listLog({ id: Number(r.lastInsertRowid) })[0];
	} catch (err) {
		h.exec('ROLLBACK');
		throw err;
	}
}

/** The maintenance log, newest first. */
export function listLog(f: { printerIds?: string[] | null; printerId?: string; id?: number; limit?: number }): MaintenanceLogEntry[] {
	const w: string[] = [];
	const v: (string | number)[] = [];
	if (f.printerIds) {
		if (!f.printerIds.length) return [];
		w.push(`printer_id IN (${f.printerIds.map(() => '?').join(',')})`);
		v.push(...f.printerIds);
	}
	if (f.printerId) w.push('printer_id = ?'), v.push(f.printerId);
	if (f.id) w.push('id = ?'), v.push(f.id);
	const rows = db()
		.prepare(`SELECT * FROM maintenance_log ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
		.all(...v, Math.min(f.limit ?? 100, 1000)) as Row[];
	return rows.map((r) => ({
		id: Number(r.id),
		taskId: r.task_id as string,
		printerId: r.printer_id as string,
		printerName: r.printer_name as string,
		taskName: r.task_name as string,
		metric: r.metric as MaintenanceMetric,
		interval: Number(r.interval),
		used: Number(r.used),
		doneAt: r.done_at as string,
		doneBy: (r.done_by as string) ?? null,
		notes: (r.notes as string) ?? null
	}));
}

/** Sends `maintenance.due` once for each task that has become overdue. Returns the tasks notified. */
export async function notifyDue(): Promise<MaintenanceTask[]> {
	const notified = new Set((db().prepare('SELECT id FROM maintenance_tasks WHERE notified_at IS NOT NULL').all() as Row[]).map((r) => r.id as string));
	const due = listTasks(listPrinters().map((p) => p.id)).filter((t) => t.status === 'overdue' && !notified.has(t.id));
	for (const t of due) {
		db().prepare('UPDATE maintenance_tasks SET notified_at = ? WHERE id = ?').run(new Date().toISOString(), t.id);
		const printer = getPrinter(t.printerId);
		await notifyEvent('maintenance.due', {
			title: `Maintenance due: ${t.name}`,
			message: `${printer?.name ?? 'A printer'}: “${t.name}” is due (every ${t.interval} ${METRIC_UNIT[t.metric]}; ${usageLabel(t)} since ${t.lastDoneAt ? 'it was last done' : 'tracking started'}).`,
			printer: printer ? { id: printer.id, name: printer.name } : null,
			path: printer ? `/p/${encodeURIComponent(printer.id)}?tab=maintenance` : '/maintenance'
		});
	}
	return due;
}
