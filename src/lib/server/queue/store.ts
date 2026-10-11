/**
 * The print queue's tables (`queue_jobs`, `queue_runs`, `queue_printers`, created by
 * migration `queue-001` in store.ts) and the global pause flag (kv `queue:paused`).
 */
import { randomUUID } from 'node:crypto';
import { deleteKv, getKv, setKv, sqlite } from '../store.ts';
import { parseTags, type QueueJob, type QueueJobStatus, type QueuePrinter, type QueueRun, type QueueSourceKind } from '#lib/queue.ts';

type Row = Record<string, unknown>;
const db = () => sqlite();
const now = () => new Date().toISOString();
const s = (v: unknown) => (typeof v === 'string' ? v : null);
const tagsOf = (v: unknown): string[] => {
	try {
		return parseTags(JSON.parse(String(v ?? '[]')));
	} catch {
		return [];
	}
};

function toRun(r: Row): QueueRun {
	return {
		id: Number(r.id),
		printerId: r.printer_id as string,
		printerName: r.printer_name as string,
		printId: r.print_id == null ? null : Number(r.print_id),
		result: r.result as QueueRun['result'],
		reason: s(r.reason),
		startedAt: r.started_at as string,
		endedAt: s(r.ended_at)
	};
}

export interface StoredJob extends QueueJob {
	position: number;
	/** Path of the file on the printer while it runs. */
	activePath: string | null;
	createdById: string | null;
}

function toJob(r: Row, runs: QueueRun[] = []): StoredJob {
	return {
		id: r.id as string,
		position: Number(r.position),
		name: r.name as string,
		source: r.source_kind as QueueSourceKind,
		sourceId: s(r.source_id),
		sourceName: null,
		path: (r.source_path as string) ?? '',
		size: r.size == null ? null : Number(r.size),
		printerId: s(r.printer_id),
		tags: tagsOf(r.tags),
		copies: Number(r.copies),
		done: Number(r.done),
		status: r.status as QueueJobStatus,
		activePrinterId: s(r.active_printer_id),
		activePath: s(r.active_path),
		error: s(r.error),
		createdById: s(r.created_by),
		createdBy: s(r.created_by_label),
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
		finishedAt: s(r.finished_at),
		runs
	};
}

/** Every job in queue order (pending first by position, then finished ones, newest first), with their last runs. */
export function listJobs(): StoredJob[] {
	const rows = db().prepare(`SELECT * FROM queue_jobs ORDER BY status IN ('failed', 'done'), CASE WHEN status IN ('failed', 'done') THEN 0 ELSE position END, updated_at DESC`).all() as Row[];
	const runs = db().prepare('SELECT * FROM queue_runs ORDER BY id DESC LIMIT 2000').all() as Row[];
	const byJob = new Map<string, QueueRun[]>();
	for (const r of runs) {
		const list = byJob.get(r.job_id as string) ?? [];
		if (list.length < 10) list.push(toRun(r));
		byJob.set(r.job_id as string, list);
	}
	return rows.map((r) => toJob(r, byJob.get(r.id as string) ?? []));
}

export function getJob(id: string): StoredJob | undefined {
	const r = db().prepare('SELECT * FROM queue_jobs WHERE id = ?').get(id) as Row | undefined;
	if (!r) return undefined;
	const runs = (db().prepare('SELECT * FROM queue_runs WHERE job_id = ? ORDER BY id DESC LIMIT 10').all(id) as Row[]).map(toRun);
	return toJob(r, runs);
}

export interface NewJob {
	name: string;
	source: QueueSourceKind;
	sourceId: string | null;
	path: string;
	size: number | null;
	printerId: string | null;
	tags: string[];
	copies: number;
	createdById: string | null;
	createdBy: string | null;
	/** Fixed id (uploads name their staged file after it). */
	id?: string;
}

export function insertJob(j: NewJob): StoredJob {
	const id = j.id ?? randomUUID();
	const t = now();
	const pos = (db().prepare('SELECT coalesce(max(position), 0) + 1 AS n FROM queue_jobs').get() as { n: number }).n;
	db()
		.prepare(
			`INSERT INTO queue_jobs (id, position, name, source_kind, source_id, source_path, size, printer_id, tags, copies, created_by, created_by_label, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, pos, j.name, j.source, j.sourceId, j.path, j.size, j.printerId, JSON.stringify(j.tags), j.copies, j.createdById, j.createdBy, t, t);
	return getJob(id)!;
}

const PATCHABLE = {
	printerId: 'printer_id',
	tags: 'tags',
	copies: 'copies',
	done: 'done',
	status: 'status',
	activePrinterId: 'active_printer_id',
	activePath: 'active_path',
	error: 'error',
	finishedAt: 'finished_at',
	position: 'position'
} as const;

export type JobPatch = Partial<{
	printerId: string | null;
	tags: string[];
	copies: number;
	done: number;
	status: QueueJobStatus;
	activePrinterId: string | null;
	activePath: string | null;
	error: string | null;
	finishedAt: string | null;
	position: number;
}>;

export function updateJob(id: string, patch: JobPatch): StoredJob | undefined {
	const sets: string[] = [];
	const values: (string | number | null)[] = [];
	for (const [k, col] of Object.entries(PATCHABLE)) {
		const v = (patch as Record<string, unknown>)[k];
		if (v === undefined) continue;
		sets.push(`${col} = ?`);
		values.push(k === 'tags' ? JSON.stringify(v) : (v as string | number | null));
	}
	if (sets.length) db().prepare(`UPDATE queue_jobs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
	return getJob(id);
}

/**
 * Changes a job's status only if it is still `from` (so a dispatcher tick and a user
 * action can't both win). Returns whether it changed.
 */
export function transition(id: string, from: QueueJobStatus | QueueJobStatus[], patch: JobPatch & { status: QueueJobStatus }): boolean {
	const list = Array.isArray(from) ? from : [from];
	const r = db()
		.prepare(`UPDATE queue_jobs SET status = ?, updated_at = ? WHERE id = ? AND status IN (${list.map(() => '?').join(', ')})`)
		.run(patch.status, now(), id, ...list);
	if (!Number(r.changes)) return false;
	updateJob(id, patch);
	return true;
}

export function deleteJob(id: string): boolean {
	setFilamentOverride(id, false);
	return Number(db().prepare('DELETE FROM queue_jobs WHERE id = ?').run(id).changes) > 0;
}

/** Puts the given pending jobs in this order (others keep their relative place after them). */
export function reorder(ids: string[]) {
	const h = db();
	const pending = (h.prepare(`SELECT id FROM queue_jobs WHERE status NOT IN ('failed', 'done') ORDER BY position`).all() as Row[]).map((r) => r.id as string);
	const wanted = ids.filter((id) => pending.includes(id));
	const order = [...wanted, ...pending.filter((id) => !wanted.includes(id))];
	h.exec('BEGIN');
	try {
		const up = h.prepare('UPDATE queue_jobs SET position = ? WHERE id = ?');
		order.forEach((id, i) => up.run(i + 1, id));
		h.exec('COMMIT');
	} catch (err) {
		h.exec('ROLLBACK');
		throw err;
	}
}

/** Moves a job one place up (-1) or down (+1) among pending jobs. */
export function move(id: string, by: -1 | 1): boolean {
	const pending = (db().prepare(`SELECT id FROM queue_jobs WHERE status NOT IN ('failed', 'done') ORDER BY position`).all() as Row[]).map((r) => r.id as string);
	const i = pending.indexOf(id);
	const j = i + by;
	if (i === -1 || j < 0 || j >= pending.length) return false;
	[pending[i], pending[j]] = [pending[j], pending[i]];
	reorder(pending);
	return true;
}

/** Sends a job to the end of the pending list (requeue after a failure). */
export function moveToEnd(id: string) {
	const pos = (db().prepare('SELECT coalesce(max(position), 0) + 1 AS n FROM queue_jobs').get() as { n: number }).n;
	db().prepare('UPDATE queue_jobs SET position = ? WHERE id = ?').run(pos, id);
}

// --- runs ------------------------------------------------------------------------------------

export function insertRun(jobId: string, printer: { id: string; name: string }): number {
	return Number(
		db()
			.prepare('INSERT INTO queue_runs (job_id, printer_id, printer_name, started_at) VALUES (?, ?, ?, ?)')
			.run(jobId, printer.id, printer.name, now()).lastInsertRowid
	);
}

export function finishRun(jobId: string, patch: { printId: number | null; result: QueueRun['result']; reason: string | null }) {
	const r = db().prepare(`SELECT id FROM queue_runs WHERE job_id = ? AND result = 'printing' ORDER BY id DESC LIMIT 1`).get(jobId) as Row | undefined;
	if (!r) return;
	db().prepare('UPDATE queue_runs SET print_id = ?, result = ?, reason = ?, ended_at = ? WHERE id = ?').run(patch.printId, patch.result, patch.reason, now(), r.id as number);
}

// --- printers --------------------------------------------------------------------------------

export type StoredQueuePrinter = Omit<QueuePrinter, 'waiting'>;

function ensurePrinter(printerId: string) {
	db().prepare('INSERT OR IGNORE INTO queue_printers (printer_id, awaiting_clear, updated_at) VALUES (?, 1, ?)').run(printerId, now());
}

export function getQueuePrinter(printerId: string): StoredQueuePrinter {
	const r = db().prepare('SELECT * FROM queue_printers WHERE printer_id = ?').get(printerId) as Row | undefined;
	if (!r) return { printerId, tags: [], awaitingClear: true, awaitingSince: null, held: false, heldReason: null };
	return {
		printerId,
		tags: tagsOf(r.tags),
		awaitingClear: r.awaiting_clear === 1,
		awaitingSince: s(r.awaiting_since),
		held: r.held === 1,
		heldReason: s(r.held_reason)
	};
}

export function setPrinterTags(printerId: string, tags: string[]) {
	ensurePrinter(printerId);
	db().prepare('UPDATE queue_printers SET tags = ?, updated_at = ? WHERE printer_id = ?').run(JSON.stringify(tags), now(), printerId);
}

export function setAwaitingClear(printerId: string, awaiting: boolean) {
	ensurePrinter(printerId);
	db()
		.prepare('UPDATE queue_printers SET awaiting_clear = ?, awaiting_since = ?, updated_at = ? WHERE printer_id = ?')
		.run(awaiting ? 1 : 0, awaiting ? now() : null, now(), printerId);
}

export function setHeld(printerId: string, held: boolean, reason: string | null = null) {
	ensurePrinter(printerId);
	db()
		.prepare('UPDATE queue_printers SET held = ?, held_reason = ?, updated_at = ? WHERE printer_id = ?')
		.run(held ? 1 : 0, held ? reason : null, now(), printerId);
}

// --- global pause ----------------------------------------------------------------------------

export const isPaused = () => getKv<boolean>('queue:paused', false);
export const setPaused = (paused: boolean) => setKv('queue:paused', paused);

// --- filament override -------------------------------------------------------------------------

/**
 * "Print anyway" on a job held for filament (kv `queue:filament-ok:<job id>`): its next
 * start skips the filament check once.
 */
const filamentKey = (jobId: string) => `queue:filament-ok:${jobId}`;
export const filamentOverride = (jobId: string) => getKv<boolean>(filamentKey(jobId), false);
export function setFilamentOverride(jobId: string, on: boolean) {
	if (on) setKv(filamentKey(jobId), true);
	else deleteKv(filamentKey(jobId));
}
