/**
 * The print queue in a configuration backup: jobs (with their runs) and each printer's
 * tags. Files uploaded to the queue (`<data dir>/queue-files`) are not included: an
 * uploaded job restored where its file is missing comes back failed, asking for the
 * file again. Restoring merges by job id; a job that was printing when the backup was
 * made comes back failed (that print is over).
 */
import { existsSync } from 'node:fs';
import { sqlite } from '../store.ts';
import { stagedPath } from './files.ts';

type Row = Record<string, unknown>;

export interface BackupQueue {
	jobs: Row[];
	runs: Row[];
	printers: { printerId: string; tags: string[] }[];
}

const JOB_COLUMNS = ['id', 'position', 'name', 'source_kind', 'source_id', 'source_path', 'size', 'printer_id', 'tags', 'copies', 'done', 'status', 'active_printer_id', 'active_path', 'error', 'created_by', 'created_by_label', 'created_at', 'updated_at', 'finished_at'];
const RUN_COLUMNS = ['job_id', 'printer_id', 'printer_name', 'print_id', 'result', 'reason', 'started_at', 'ended_at'];

const pick = (r: Row, cols: string[]) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]));

export function exportQueue(): BackupQueue {
	const h = sqlite();
	return {
		jobs: (h.prepare('SELECT * FROM queue_jobs ORDER BY position').all() as Row[]).map((r) => pick(r, JOB_COLUMNS)),
		runs: (h.prepare('SELECT * FROM queue_runs ORDER BY id').all() as Row[]).map((r) => pick(r, RUN_COLUMNS)),
		printers: (h.prepare('SELECT printer_id, tags FROM queue_printers').all() as Row[]).map((r) => ({ printerId: r.printer_id as string, tags: JSON.parse((r.tags as string) || '[]') }))
	};
}

export function checkQueue(raw: unknown): BackupQueue {
	const q = raw as BackupQueue;
	if (!q || typeof q !== 'object' || !Array.isArray(q.jobs) || !Array.isArray(q.runs) || !Array.isArray(q.printers)) throw new Error('print queue');
	for (const j of q.jobs) if (!j || typeof j.id !== 'string' || typeof j.name !== 'string') throw new Error('a queued job');
	return q;
}

export function previewQueue(q: BackupQueue): { jobs: number; added: number; tags: number } {
	const exists = sqlite().prepare('SELECT 1 FROM queue_jobs WHERE id = ?');
	return { jobs: q.jobs.length, added: q.jobs.filter((j) => !exists.get(j.id as string)).length, tags: q.printers.length };
}

/** Adds the jobs that aren't here yet and sets printer tags (call inside a transaction). */
export function importQueue(q: BackupQueue, mapUser: (id: string) => string | null): { added: number; skipped: number; tags: number } {
	const h = sqlite();
	const exists = h.prepare('SELECT 1 FROM queue_jobs WHERE id = ?');
	const printerExists = h.prepare('SELECT 1 FROM printers WHERE id = ?');
	const insertJob = h.prepare(`INSERT INTO queue_jobs (${JOB_COLUMNS.join(', ')}) VALUES (${JOB_COLUMNS.map(() => '?').join(', ')})`);
	const insertRun = h.prepare(`INSERT INTO queue_runs (${RUN_COLUMNS.join(', ')}) VALUES (${RUN_COLUMNS.map(() => '?').join(', ')})`);
	const now = new Date().toISOString();
	const added = new Set<string>();
	let skipped = 0;
	for (const j of q.jobs) {
		const id = j.id as string;
		if (exists.get(id)) {
			skipped++;
			continue;
		}
		const row: Row = { ...pick(j, JOB_COLUMNS) };
		if (row.status === 'printing' || row.status === 'starting') Object.assign(row, { status: 'failed', error: 'Was printing when the backup was made', active_printer_id: null, active_path: null, updated_at: now });
		if (row.source_kind === 'upload' && (row.status === 'queued' || row.status === 'failed') && !existsSync(stagedPath(id))) {
			Object.assign(row, { status: 'failed', error: 'Its uploaded file isn’t in the backup: upload it again', updated_at: now });
		}
		if (row.printer_id && !printerExists.get(row.printer_id as string)) row.printer_id = null;
		row.created_by = row.created_by ? mapUser(row.created_by as string) : null;
		insertJob.run(...(JOB_COLUMNS.map((c) => row[c] ?? null) as (string | number | null)[]));
		added.add(id);
	}
	for (const r of q.runs) if (added.has(r.job_id as string)) insertRun.run(...(RUN_COLUMNS.map((c) => r[c] ?? null) as (string | number | null)[]));
	const upsert = h.prepare(`INSERT INTO queue_printers (printer_id, tags, updated_at) VALUES (?, ?, ?) ON CONFLICT(printer_id) DO UPDATE SET tags = excluded.tags, updated_at = excluded.updated_at`);
	let tags = 0;
	for (const p of q.printers) {
		if (typeof p.printerId !== 'string' || !printerExists.get(p.printerId)) continue;
		upsert.run(p.printerId, JSON.stringify(Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string') : []), now);
		tags++;
	}
	return { added: added.size, skipped, tags };
}
