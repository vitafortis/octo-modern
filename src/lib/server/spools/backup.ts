/**
 * Spoolman, costs and maintenance in a configuration backup: the Spoolman connection
 * (its auth header value decrypted, re-sealed on restore), cost settings, which spool is
 * on which printer and tool, and maintenance tasks with their log. Not included: the
 * per-print Spoolman reports (`spool_usage`), so a restore never reports filament twice.
 */
import { decrypt, encrypt } from '../crypto.ts';
import { getKv, setKv, sqlite } from '../store.ts';

type Row = Record<string, unknown>;

export interface BackupFilament {
	spoolman: (Record<string, unknown> & { authValue: string | null }) | null;
	costs: Record<string, unknown> | null;
	assignments: Row[];
	tasks: Row[];
	log: Row[];
}

const SPOOLMAN = 'spoolman:settings';
const COSTS = 'costs:settings';
const TASK_COLUMNS = ['id', 'printer_id', 'name', 'metric', 'interval', 'notes', 'sort', 'created_at', 'last_done_at', 'last_done_by', 'notified_at'];
const LOG_COLUMNS = ['task_id', 'printer_id', 'printer_name', 'task_name', 'metric', 'interval', 'used', 'done_at', 'user_id', 'done_by', 'notes'];
const ASSIGN_COLUMNS = ['printer_id', 'tool', 'spool_id', 'assigned_at', 'assigned_by'];
const pick = (r: Row, cols: string[]) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]));
const values = (r: Row, cols: string[]) => cols.map((c) => r[c] ?? null) as (string | number | null)[];

export function exportFilament(): BackupFilament {
	const h = sqlite();
	const sm = getKv<Record<string, unknown> | null>(SPOOLMAN, null);
	return {
		spoolman: sm ? { ...sm, sealed: null, authValue: typeof sm.sealed === 'string' ? decrypt(sm.sealed, 'spoolman') : null } : null,
		costs: getKv<Record<string, unknown> | null>(COSTS, null),
		assignments: (h.prepare('SELECT * FROM spool_assignments').all() as Row[]).map((r) => pick(r, ASSIGN_COLUMNS)),
		tasks: (h.prepare('SELECT * FROM maintenance_tasks ORDER BY sort, created_at').all() as Row[]).map((r) => pick(r, TASK_COLUMNS)),
		log: (h.prepare('SELECT * FROM maintenance_log ORDER BY id').all() as Row[]).map((r) => pick(r, LOG_COLUMNS))
	};
}

export function checkFilament(raw: unknown): BackupFilament {
	const f = raw as BackupFilament;
	if (!f || typeof f !== 'object' || !Array.isArray(f.assignments) || !Array.isArray(f.tasks) || !Array.isArray(f.log)) throw new Error('filament and maintenance');
	return f;
}

export function previewFilament(f: BackupFilament): { spoolman: string | null; assignments: number; tasks: number; newTasks: number; log: number } {
	const exists = sqlite().prepare('SELECT 1 FROM maintenance_tasks WHERE id = ?');
	return {
		spoolman: typeof f.spoolman?.url === 'string' ? f.spoolman.url : null,
		assignments: f.assignments.length,
		tasks: f.tasks.length,
		newTasks: f.tasks.filter((t) => !exists.get(t.id as string)).length,
		log: f.log.length
	};
}

/**
 * Replaces the Spoolman and cost settings and the spool assignments of printers that
 * exist here; adds maintenance tasks and log entries that aren't here yet (call inside
 * a transaction).
 */
export function importFilament(f: BackupFilament, mapUser: (id: string) => string | null): { assignments: number; tasks: number; log: number } {
	const h = sqlite();
	if (f.spoolman) {
		const { authValue, ...rest } = f.spoolman;
		setKv(SPOOLMAN, { ...rest, sealed: authValue ? encrypt(String(authValue), 'spoolman') : null });
	}
	if (f.costs) setKv(COSTS, f.costs);
	const printerExists = h.prepare('SELECT 1 FROM printers WHERE id = ?');
	const result = { assignments: 0, tasks: 0, log: 0 };
	const restoredPrinters = new Set(f.assignments.map((a) => a.printer_id as string).filter((id) => printerExists.get(id)));
	const clear = h.prepare('DELETE FROM spool_assignments WHERE printer_id = ?');
	for (const id of restoredPrinters) clear.run(id);
	const assign = h.prepare(`INSERT OR REPLACE INTO spool_assignments (${ASSIGN_COLUMNS.join(', ')}) VALUES (${ASSIGN_COLUMNS.map(() => '?').join(', ')})`);
	for (const a of f.assignments) {
		if (!restoredPrinters.has(a.printer_id as string)) continue;
		assign.run(...values(a, ASSIGN_COLUMNS));
		result.assignments++;
	}
	const taskExists = h.prepare('SELECT 1 FROM maintenance_tasks WHERE id = ?');
	const task = h.prepare(`INSERT INTO maintenance_tasks (${TASK_COLUMNS.join(', ')}) VALUES (${TASK_COLUMNS.map(() => '?').join(', ')})`);
	for (const t of f.tasks) {
		if (typeof t.id !== 'string' || taskExists.get(t.id) || !printerExists.get(t.printer_id as string)) continue;
		task.run(...values(t, TASK_COLUMNS));
		result.tasks++;
	}
	const logExists = h.prepare('SELECT 1 FROM maintenance_log WHERE task_id = ? AND done_at = ?');
	const log = h.prepare(`INSERT INTO maintenance_log (${LOG_COLUMNS.join(', ')}) VALUES (${LOG_COLUMNS.map(() => '?').join(', ')})`);
	for (const l of f.log) {
		if (logExists.get(l.task_id as string, l.done_at as string)) continue;
		log.run(...values({ ...l, user_id: l.user_id ? mapUser(l.user_id as string) : null }, LOG_COLUMNS));
		result.log++;
	}
	return result;
}
