/**
 * The print history in a configuration backup: every entry, optionally with its
 * picture (base64). Restoring merges: an entry already here (same printer, start and
 * file, or the same import key) is kept, the rest are added. Rows only, no printers.
 */
import { sqlite } from '../store.ts';
import type { PrintResult } from '#lib/history.ts';

export interface BackupPrint {
	printerId: string;
	printerName: string;
	file: string;
	path: string;
	origin: string;
	startedAt: string;
	endedAt: string | null;
	durationS: number | null;
	result: PrintResult;
	reason: string | null;
	filamentMm: number | null;
	estimatedS: number | null;
	completion: number | null;
	userId: string | null;
	startedBy: string | null;
	octoprintUser: string | null;
	source: 'live' | 'import';
	notes: string | null;
	externalKey: string | null;
	/** base64, when the backup includes pictures. */
	thumbnail?: string | null;
	thumbnailType?: string | null;
}

export interface BackupHistory {
	images: boolean;
	prints: BackupPrint[];
}

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : null);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function exportHistory(images: boolean): BackupHistory {
	const rows = sqlite()
		.prepare(`SELECT *${images ? '' : ', NULL AS thumbnail'} FROM prints ORDER BY started_at, id`)
		.all() as Row[];
	return {
		images,
		prints: rows.map((r) => ({
			printerId: r.printer_id as string,
			printerName: r.printer_name as string,
			file: r.file_name as string,
			path: r.file_path as string,
			origin: (r.origin as string) ?? 'local',
			startedAt: r.started_at as string,
			endedAt: s(r.ended_at),
			durationS: n(r.duration_s),
			result: r.result as PrintResult,
			reason: s(r.reason),
			filamentMm: n(r.filament_mm),
			estimatedS: n(r.estimated_s),
			completion: n(r.completion),
			userId: s(r.user_id),
			startedBy: s(r.started_by),
			octoprintUser: s(r.octoprint_user),
			source: r.source === 'import' ? 'import' : 'live',
			notes: s(r.notes),
			externalKey: s(r.external_key),
			...(images && r.thumbnail ? { thumbnail: Buffer.from(r.thumbnail as Uint8Array).toString('base64'), thumbnailType: s(r.thumbnail_type) ?? 'image/jpeg' } : {})
		}))
	};
}

const RESULTS = new Set(['printing', 'paused', 'success', 'failed', 'cancelled']);

/** Throws a message naming the first bad entry. */
export function checkHistory(raw: unknown): BackupHistory {
	const h = raw as BackupHistory;
	if (!h || typeof h !== 'object' || !Array.isArray(h.prints)) throw new Error('print history');
	for (const [i, p] of h.prints.entries()) {
		if (!p || typeof p.printerId !== 'string' || typeof p.file !== 'string' || typeof p.startedAt !== 'string' || !RESULTS.has(p.result)) throw new Error(`print history entry ${i + 1}`);
	}
	return h;
}

function existsStmt() {
	return sqlite().prepare('SELECT 1 FROM prints WHERE (printer_id = ? AND started_at = ? AND file_path = ?) OR (external_key IS NOT NULL AND external_key = ?) LIMIT 1');
}

/** How many entries would be added (the rest exist already). */
export function previewHistory(h: BackupHistory): { total: number; added: number } {
	const exists = existsStmt();
	let added = 0;
	for (const p of h.prints) if (!exists.get(p.printerId, p.startedAt, p.path ?? p.file, p.externalKey ?? null)) added++;
	return { total: h.prints.length, added };
}

/**
 * Adds the entries that aren't here yet (call inside a transaction). Entries still
 * "printing" in the backup are recorded as failed ("lost track"): that print is over.
 */
export function importHistoryRows(h: BackupHistory, mapUser: (id: string) => string | null = (id) => id): { added: number; skipped: number } {
	const exists = existsStmt();
	const insert = sqlite().prepare(
		`INSERT INTO prints (printer_id, printer_name, file_name, file_path, origin, started_at, ended_at, duration_s, result, reason, filament_mm, estimated_s, completion, user_id, started_by, octoprint_user, source, notes, external_key, thumbnail, thumbnail_type)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	let added = 0;
	let skipped = 0;
	for (const p of h.prints) {
		const path = p.path ?? p.file;
		if (exists.get(p.printerId, p.startedAt, path, p.externalKey ?? null)) {
			skipped++;
			continue;
		}
		const open = p.result === 'printing' || p.result === 'paused';
		const thumb = typeof p.thumbnail === 'string' && p.thumbnail ? Buffer.from(p.thumbnail, 'base64') : null;
		insert.run(
			p.printerId,
			p.printerName ?? p.printerId,
			p.file,
			path,
			p.origin ?? 'local',
			p.startedAt,
			p.endedAt ?? (open ? p.startedAt : null),
			n(p.durationS),
			open ? 'failed' : p.result,
			open ? 'lost track' : s(p.reason),
			n(p.filamentMm),
			n(p.estimatedS),
			n(p.completion),
			p.userId ? mapUser(p.userId) : null,
			s(p.startedBy),
			s(p.octoprintUser),
			p.source === 'import' ? 'import' : 'live',
			s(p.notes),
			s(p.externalKey),
			thumb,
			thumb ? (s(p.thumbnailType) ?? 'image/jpeg') : null
		);
		added++;
	}
	return { added, skipped };
}
