/**
 * The print history table (`prints`, created by migration `history-001-prints` in
 * store.ts). Times are ISO strings, so they sort and compare as text.
 */
import { sqlite } from '../store.ts';
import type { HistoryFilter, PrintRecord, PrintResult } from '#lib/history.ts';

type Row = Record<string, unknown>;
const db = () => sqlite();

const COLUMNS =
	'id, printer_id, printer_name, file_name, file_path, origin, started_at, ended_at, duration_s, result, reason, filament_mm, estimated_s, completion, user_id, started_by, octoprint_user, source, notes, thumbnail IS NOT NULL AS has_thumb';

function toRecord(r: Row): PrintRecord {
	const n = (v: unknown) => (typeof v === 'number' ? v : null);
	const s = (v: unknown) => (typeof v === 'string' ? v : null);
	return {
		id: Number(r.id),
		printerId: r.printer_id as string,
		printerName: r.printer_name as string,
		file: r.file_name as string,
		path: r.file_path as string,
		origin: r.origin as string,
		startedAt: r.started_at as string,
		endedAt: s(r.ended_at),
		durationS: n(r.duration_s),
		result: r.result as PrintResult,
		reason: s(r.reason),
		filamentMm: n(r.filament_mm),
		estimatedS: n(r.estimated_s),
		completion: n(r.completion),
		startedBy: s(r.started_by),
		octoprintUser: s(r.octoprint_user),
		source: r.source === 'import' ? 'import' : 'live',
		hasThumbnail: Number(r.has_thumb) === 1,
		notes: s(r.notes)
	};
}

export interface NewPrint {
	printerId: string;
	printerName: string;
	file: string;
	path: string;
	origin: string;
	startedAt: string;
	endedAt?: string | null;
	durationS?: number | null;
	result: PrintResult;
	reason?: string | null;
	filamentMm?: number | null;
	estimatedS?: number | null;
	completion?: number | null;
	userId?: string | null;
	startedBy?: string | null;
	octoprintUser?: string | null;
	source?: 'live' | 'import';
	notes?: string | null;
	externalKey?: string | null;
}

/** Inserts a print; returns its id, or null when `externalKey` was imported before. */
export function insertPrint(p: NewPrint): number | null {
	const r = db()
		.prepare(
			`INSERT OR IGNORE INTO prints (printer_id, printer_name, file_name, file_path, origin, started_at, ended_at, duration_s, result, reason,
			   filament_mm, estimated_s, completion, user_id, started_by, octoprint_user, source, notes, external_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			p.printerId,
			p.printerName,
			p.file,
			p.path,
			p.origin,
			p.startedAt,
			p.endedAt ?? null,
			p.durationS ?? null,
			p.result,
			p.reason ?? null,
			p.filamentMm ?? null,
			p.estimatedS ?? null,
			p.completion ?? null,
			p.userId ?? null,
			p.startedBy ?? null,
			p.octoprintUser ?? null,
			p.source ?? 'live',
			p.notes ?? null,
			p.externalKey ?? null
		);
	return Number(r.changes) ? Number(r.lastInsertRowid) : null;
}

const PATCHABLE = {
	endedAt: 'ended_at',
	durationS: 'duration_s',
	result: 'result',
	reason: 'reason',
	filamentMm: 'filament_mm',
	estimatedS: 'estimated_s',
	completion: 'completion',
	notes: 'notes',
	octoprintUser: 'octoprint_user'
} as const;

export function updatePrint(id: number, patch: Partial<Record<keyof typeof PATCHABLE, string | number | null>>) {
	const sets: string[] = [];
	const values: (string | number | null)[] = [];
	for (const [k, col] of Object.entries(PATCHABLE)) {
		const v = patch[k as keyof typeof PATCHABLE];
		if (v !== undefined) sets.push(`${col} = ?`), values.push(v);
	}
	if (sets.length) db().prepare(`UPDATE prints SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

export function setThumbnail(id: number, data: Uint8Array, type: string) {
	db().prepare('UPDATE prints SET thumbnail = ?, thumbnail_type = ? WHERE id = ?').run(data, type, id);
}

export function getThumbnail(id: number): { data: Uint8Array; type: string } | undefined {
	const r = db().prepare('SELECT thumbnail, thumbnail_type FROM prints WHERE id = ? AND thumbnail IS NOT NULL').get(id) as Row | undefined;
	return r ? { data: r.thumbnail as Uint8Array, type: (r.thumbnail_type as string) || 'image/jpeg' } : undefined;
}

export function getPrint(id: number): PrintRecord | undefined {
	const r = db().prepare(`SELECT ${COLUMNS} FROM prints WHERE id = ?`).get(id) as Row | undefined;
	return r && toRecord(r);
}

export function deletePrint(id: number): boolean {
	return Number(db().prepare('DELETE FROM prints WHERE id = ?').run(id).changes) > 0;
}

/** Prints of a printer still marked running, newest first. */
export function openPrints(printerId: string): PrintRecord[] {
	return (db().prepare(`SELECT ${COLUMNS} FROM prints WHERE printer_id = ? AND result IN ('printing', 'paused') ORDER BY id DESC`).all(printerId) as Row[]).map(toRecord);
}

/** The latest ended print of this file on this printer, if it ended at or after `since`. */
export function lastEnded(printerId: string, path: string, origin: string, since: string): PrintRecord | undefined {
	const r = db()
		.prepare(`SELECT ${COLUMNS} FROM prints WHERE printer_id = ? AND file_path = ? AND origin = ? AND ended_at >= ? ORDER BY id DESC LIMIT 1`)
		.get(printerId, path, origin, since) as Row | undefined;
	return r && toRecord(r);
}

/** Any print of this file on this printer that ended within [from, to] (to skip duplicates when importing). */
export function endedBetween(printerId: string, path: string, from: string, to: string): boolean {
	return !!db().prepare('SELECT 1 FROM prints WHERE printer_id = ? AND file_path = ? AND ended_at BETWEEN ? AND ? LIMIT 1').get(printerId, path, from, to);
}

/** `YYYY-MM-DD` (UTC day) or any ISO timestamp, as an ISO bound; `end` makes a bare date inclusive. */
export function dateBound(v: string | undefined, end = false): string | null {
	if (!v) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
		const d = new Date(`${v}T00:00:00.000Z`);
		if (Number.isNaN(d.getTime())) return null;
		if (end) d.setUTCDate(d.getUTCDate() + 1);
		return d.toISOString();
	}
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function where(f: HistoryFilter & { printerIds?: string[] | null }): { sql: string; values: (string | number)[] } {
	const w: string[] = [];
	const values: (string | number)[] = [];
	if (f.printerIds) {
		if (!f.printerIds.length) return { sql: 'WHERE 0', values };
		w.push(`printer_id IN (${f.printerIds.map(() => '?').join(',')})`);
		values.push(...f.printerIds);
	}
	if (f.printer) w.push('printer_id = ?'), values.push(f.printer);
	if (f.result) w.push('result = ?'), values.push(f.result);
	const from = dateBound(f.from);
	const to = dateBound(f.to, true);
	if (from) w.push('started_at >= ?'), values.push(from);
	if (to) w.push('started_at < ?'), values.push(to);
	const q = f.q?.trim();
	if (q) {
		const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		w.push(`(file_name LIKE ? ESCAPE '\\' OR file_path LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR started_by LIKE ? ESCAPE '\\' OR printer_name LIKE ? ESCAPE '\\')`);
		values.push(like, like, like, like, like);
	}
	return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', values };
}

/**
 * Prints matching the filter, newest first. `printerIds` limits them to printers the
 * user may see (null: every printer, including removed ones, for admins). Pages with
 * `before` (an id from the previous page).
 */
export function listPrints(f: HistoryFilter & { printerIds?: string[] | null; limit?: number; before?: number }): PrintRecord[] {
	const { sql, values } = where(f);
	const page = f.before ? `${sql ? `${sql} AND` : 'WHERE'} (started_at, id) < ((SELECT started_at FROM prints WHERE id = ?), ?)` : sql;
	const extra = f.before ? [f.before, f.before] : [];
	const limit = Math.max(1, Math.min(f.limit ?? 100, 100_000));
	return (db().prepare(`SELECT ${COLUMNS} FROM prints ${page} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...values, ...extra, limit) as Row[]).map(toRecord);
}

/** How many prints match the filter. */
export function countPrints(f: HistoryFilter & { printerIds?: string[] | null }): number {
	const { sql, values } = where(f);
	return Number((db().prepare(`SELECT count(*) AS n FROM prints ${sql}`).get(...values) as Row).n);
}

/** Who started a print on this printer through octo·modern since `since` (the newest such audit entry). */
export function auditedStarter(printerId: string, since: string, fileNames: string[]): { userId: string | null; label: string } | null {
	const rows = db()
		.prepare(
			`SELECT a.user_id, a.user_email, a.detail, u.name FROM audit a LEFT JOIN users u ON u.id = a.user_id
			 WHERE a.printer_id = ? AND a.action IN ('job.start', 'job.restart') AND a.at >= ? ORDER BY a.id DESC LIMIT 10`
		)
		.all(printerId, since) as Row[];
	// Only an entry naming this file (start: its path; upload & print and restart: its name).
	const names = fileNames.filter(Boolean);
	const match = rows.find((r) => typeof r.detail === 'string' && names.some((n) => (r.detail as string).endsWith(n)));
	if (!match || (!match.user_id && !match.user_email)) return null;
	return { userId: (match.user_id as string) ?? null, label: (match.name as string) || (match.user_email as string) || 'unknown' };
}
