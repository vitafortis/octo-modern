/**
 * Backfills the history from what OctoPrint already knows, best effort:
 * - the PrintJobHistory plugin, if installed: every print it recorded;
 * - otherwise (and in addition), each file's own statistics: OctoPrint keeps the
 *   date, outcome and print time of a file's *last* print (plus success/failure
 *   counts, which can't be dated and aren't imported). OctoPrint counts a cancel as a
 *   failure, so these come in as "failed" with reason `octoprint-stats`.
 * Klipper printers: Moonraker's own job history (`server.history.list`), which records
 * every print with its outcome, duration and filament used.
 * Imports are idempotent (keyed by their source) and skip prints octo·modern already
 * recorded live.
 */
import { clientFor } from '../octoprint/manager.ts';
import { moonrakerBackend } from '../backend/index.ts';
import { getKv, setKv } from '../store.ts';
import { endedBetween, insertPrint } from './store.ts';
import type { PrintResult } from '#lib/history.ts';
import type { Printer } from '#lib/types.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export interface ImportedPrint {
	key: string;
	file: string;
	path: string;
	origin: string;
	startedAt: number;
	endedAt: number | null;
	durationS: number | null;
	result: PrintResult;
	reason: string | null;
	filamentMm: number | null;
	estimatedS: number | null;
	user: string | null;
	notes: string | null;
}

/** Every file with a recorded last print, from /api/files?recursive=true. */
export function printsFromFileStats(raw: unknown): ImportedPrint[] {
	const out: ImportedPrint[] = [];
	const walk = (list: unknown) => {
		if (!Array.isArray(list)) return;
		for (const f of list) {
			if (!isObj(f)) continue;
			if (f.type === 'folder') {
				walk(f.children);
				continue;
			}
			const prints = isObj(f.prints) ? f.prints : null;
			const last = prints && isObj(prints.last) ? prints.last : null;
			const date = last ? num(last.date) : null;
			const path = str(f.path) ?? str(f.name);
			if (!last || date == null || !path || typeof last.success !== 'boolean') continue;
			const origin = f.origin === 'sdcard' ? 'sdcard' : 'local';
			const printTime = num(last.printTime);
			const analysis = isObj(f.gcodeAnalysis) ? f.gcodeAnalysis : null;
			let filamentMm: number | null = null;
			if (analysis && isObj(analysis.filament)) {
				for (const t of Object.values(analysis.filament)) {
					const len = isObj(t) ? num(t.length) : null;
					if (len != null) filamentMm = (filamentMm ?? 0) + len;
				}
			}
			const endedAt = date * 1000;
			out.push({
				key: `stats:${origin}:${path}:${Math.round(date)}`,
				file: str(f.display) ?? str(f.name) ?? path,
				path,
				origin,
				startedAt: printTime != null ? endedAt - printTime * 1000 : endedAt,
				endedAt,
				durationS: printTime,
				result: last.success ? 'success' : 'failed',
				reason: last.success ? null : 'octoprint-stats',
				// A failed print used an unknown share of it.
				filamentMm: last.success ? filamentMm : null,
				estimatedS: analysis ? num(analysis.estimatedPrintTime) : null,
				user: null,
				notes: null
			});
		}
	};
	walk(isObj(raw) ? raw.files : null);
	return out;
}

/** "2024-03-01T10:20:00", "01.03.2024 10:20[:30]" (local time) or epoch seconds. */
export function parseLooseDate(v: unknown): number | null {
	const n = num(v);
	if (n != null) return n > 1e12 ? n : n * 1000;
	const s = str(v);
	if (!s) return null;
	const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
	if (de) return new Date(+de[3], +de[2] - 1, +de[1], +de[4], +de[5], +(de[6] ?? 0)).getTime();
	const t = Date.parse(s.includes('T') || !/^\d{4}-\d{2}-\d{2} /.test(s) ? s : s.replace(' ', 'T'));
	return Number.isNaN(t) ? null : t;
}

/** The PrintJobHistory plugin's `loadPrintJobHistoryByQuery` answer. Field names vary by plugin version. */
export function printsFromPrintJobHistory(raw: unknown): ImportedPrint[] {
	const list = isObj(raw) && Array.isArray(raw.allPrintJobs) ? raw.allPrintJobs : Array.isArray(raw) ? raw : [];
	const out: ImportedPrint[] = [];
	for (const j of list) {
		if (!isObj(j)) continue;
		const id = j.databaseId ?? j.id;
		const start = parseLooseDate(j.printStartDateTime ?? j.printStartDateTimeFormatted);
		const path = str(j.filePathName) ?? str(j.fileName);
		if (id == null || start == null || !path) continue;
		const end = parseLooseDate(j.printEndDateTime ?? j.printEndDateTimeFormatted);
		const duration = num(j.duration) ?? (end != null ? (end - start) / 1000 : null);
		const status = (str(j.printStatusResult) ?? '').toLowerCase();
		const result: PrintResult = status === 'success' ? 'success' : /cancel/.test(status) ? 'cancelled' : 'failed';
		const filaments = Array.isArray(j.filamentModels) ? j.filamentModels : isObj(j.filamentModel) ? [j.filamentModel] : [];
		let filamentMm: number | null = null;
		for (const f of filaments) {
			const len = isObj(f) ? num(f.usedLength) : null;
			if (len != null) filamentMm = (filamentMm ?? 0) + len;
		}
		out.push({
			key: `pjh:${id}`,
			file: str(j.fileName) ?? path,
			path,
			origin: str(j.fileOrigin) === 'sdcard' ? 'sdcard' : 'local',
			startedAt: start,
			endedAt: end ?? (duration != null ? start + duration * 1000 : null),
			durationS: duration,
			result,
			reason: result === 'failed' ? status || 'failed' : null,
			filamentMm,
			estimatedS: null,
			user: str(j.userName),
			notes: str(j.noteText)
		});
	}
	return out;
}

const MOONRAKER_RESULT: Record<string, PrintResult> = { completed: 'success', cancelled: 'cancelled' };

/** Jobs from Moonraker's `server.history.list` (`start_time`/`end_time` in epoch seconds). */
export function printsFromMoonrakerHistory(jobs: unknown): ImportedPrint[] {
	if (!Array.isArray(jobs)) return [];
	const out: ImportedPrint[] = [];
	for (const j of jobs) {
		if (!isObj(j)) continue;
		const status = str(j.status);
		const path = str(j.filename);
		const start = num(j.start_time);
		if (!status || status === 'in_progress' || !path || start == null) continue;
		const end = num(j.end_time);
		const meta = isObj(j.metadata) ? j.metadata : {};
		const result = MOONRAKER_RESULT[status] ?? 'failed';
		out.push({
			key: `moonraker:${str(j.job_id) ?? `${path}@${start}`}`,
			file: path.split('/').pop() ?? path,
			path,
			origin: 'local',
			startedAt: Math.round(start * 1000),
			endedAt: end != null ? Math.round(end * 1000) : null,
			durationS: num(j.total_duration) ?? num(j.print_duration),
			result,
			reason: result === 'failed' ? status : null,
			filamentMm: num(j.filament_used),
			estimatedS: num(meta.estimated_time),
			user: str(j.user),
			notes: null
		});
	}
	return out;
}

async function moonrakerPrints(printer: Printer): Promise<ImportedPrint[]> {
	const backend = moonrakerBackend(printer);
	const out: ImportedPrint[] = [];
	for (let start = 0; start < 2_000; start += 200) {
		const page = await backend.historyPage(start, 200);
		const jobs = Array.isArray(page?.jobs) ? page.jobs : [];
		out.push(...printsFromMoonrakerHistory(jobs));
		if (jobs.length < 200) break;
	}
	return out;
}

export interface ImportResult {
	imported: number;
	skipped: number;
	sources: string[];
}

/** Imports one printer's history from OctoPrint or Moonraker. Throws only if the server can't be reached at all. */
export async function importHistory(printer: Printer): Promise<ImportResult> {
	const found: ImportedPrint[] = [];
	const sources: string[] = [];
	if (printer.kind === 'moonraker') {
		found.push(...(await moonrakerPrints(printer)));
		if (found.length) sources.push('Moonraker job history');
		return record(printer, found, sources);
	}
	const client = clientFor(printer);
	try {
		const q = new URLSearchParams({ from: '0', to: '100000', sortColumn: 'printStartDateTime', sortOrder: 'desc', filterName: 'all', startDate: '', endDate: '' });
		const res = await client.request('GET', `/plugin/PrintJobHistory/loadPrintJobHistoryByQuery?${q}`, { allow: [400, 403, 404, 405, 500], timeoutMs: 20_000 });
		if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
			const jobs = printsFromPrintJobHistory(await res.json());
			if (jobs.length) sources.push('PrintJobHistory');
			found.push(...jobs);
		} else await res.body?.cancel();
	} catch {
		// Not installed, or older/newer API: the file statistics still work.
	}
	const stats = printsFromFileStats(await client.files());
	if (stats.length) sources.push('file statistics');
	// PrintJobHistory already covers the files' last prints.
	if (!found.length) found.push(...stats);
	return record(printer, found, sources);
}

function record(printer: Printer, found: ImportedPrint[], sources: string[]): ImportResult {
	let imported = 0;
	let skipped = 0;
	for (const p of found) {
		const end = p.endedAt ?? p.startedAt;
		if (endedBetween(printer.id, p.path, new Date(end - 120_000).toISOString(), new Date(end + 120_000).toISOString())) {
			skipped++;
			continue;
		}
		const id = insertPrint({
			printerId: printer.id,
			printerName: printer.name,
			file: p.file,
			path: p.path,
			origin: p.origin,
			startedAt: new Date(p.startedAt).toISOString(),
			endedAt: p.endedAt != null ? new Date(p.endedAt).toISOString() : null,
			durationS: p.durationS,
			result: p.result,
			reason: p.reason,
			filamentMm: p.filamentMm,
			estimatedS: p.estimatedS,
			completion: p.result === 'success' ? 100 : null,
			octoprintUser: p.user,
			source: 'import',
			notes: p.notes,
			externalKey: `${printer.id}:${p.key}`
		});
		if (id == null) skipped++;
		else imported++;
	}
	setKv(`history:imported:${printer.id}`, new Date().toISOString());
	return { imported, skipped, sources };
}

/** When this printer's history was last imported (null: never). */
export function importedAt(printerId: string): string | null {
	return getKv<string | null>(`history:imported:${printerId}`, null);
}
