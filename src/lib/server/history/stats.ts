/**
 * Print history aggregates and CSV export. Pure.
 */
import type { HistoryStats, PrintRecord, PrinterStats, WeekStats } from '#lib/history.ts';

const FINISHED = new Set(['success', 'failed', 'cancelled']);

/** Monday (UTC) of the week a timestamp falls in, `YYYY-MM-DD`. */
export function weekOf(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	const day = (d.getUTCDay() + 6) % 7; // Monday = 0
	const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
	return monday.toISOString().slice(0, 10);
}

/**
 * Totals over finished prints: success rate, print time and filament, per printer
 * and per week. Weeks without prints between the first and last are filled with zeros
 * (at most `maxWeeks`, the most recent ones), so a chart shows gaps as gaps.
 */
export function aggregate(records: (Pick<PrintRecord, 'printerId' | 'printerName' | 'result' | 'startedAt' | 'durationS' | 'filamentMm'> & { cost?: number | null })[], maxWeeks = 26): HistoryStats {
	const perPrinter = new Map<string, PrinterStats>();
	const perWeek = new Map<string, WeekStats>();
	const total = { prints: 0, success: 0, failed: 0, cancelled: 0, printTime: 0, filamentMm: 0, cost: 0, costed: 0 };
	for (const r of records) {
		if (!FINISHED.has(r.result)) continue;
		const result = r.result as 'success' | 'failed' | 'cancelled';
		const time = r.durationS != null && Number.isFinite(r.durationS) && r.durationS > 0 ? r.durationS : 0;
		const fil = r.filamentMm != null && Number.isFinite(r.filamentMm) && r.filamentMm > 0 ? r.filamentMm : 0;
		let p = perPrinter.get(r.printerId);
		if (!p) perPrinter.set(r.printerId, (p = { printerId: r.printerId, printerName: r.printerName, prints: 0, success: 0, failed: 0, cancelled: 0, printTime: 0, filamentMm: 0, cost: 0 }));
		const wk = weekOf(r.startedAt);
		let w = perWeek.get(wk);
		if (!w && wk) perWeek.set(wk, (w = { week: wk, prints: 0, success: 0, failed: 0, cancelled: 0, printTime: 0, filamentMm: 0 }));
		for (const t of [total, p, w]) {
			if (!t) continue;
			t.prints++;
			t[result]++;
			t.printTime += time;
			t.filamentMm += fil;
		}
		if (r.cost != null && Number.isFinite(r.cost)) {
			total.cost += r.cost;
			total.costed++;
			p.cost += r.cost;
		}
	}
	const weeks = [...perWeek.keys()].sort();
	const filled: WeekStats[] = [];
	if (weeks.length) {
		const last = new Date(`${weeks.at(-1)}T00:00:00Z`).getTime();
		const first = Math.max(new Date(`${weeks[0]}T00:00:00Z`).getTime(), last - (maxWeeks - 1) * 7 * 86_400_000);
		for (let t = first; t <= last; t += 7 * 86_400_000) {
			const key = new Date(t).toISOString().slice(0, 10);
			filled.push(perWeek.get(key) ?? { week: key, prints: 0, success: 0, failed: 0, cancelled: 0, printTime: 0, filamentMm: 0 });
		}
	}
	const decided = total.success + total.failed + total.cancelled;
	return {
		...total,
		successRate: decided ? total.success / decided : null,
		perPrinter: [...perPrinter.values()].sort((a, b) => b.prints - a.prints || a.printerName.localeCompare(b.printerName)),
		perWeek: filled
	};
}

// --- CSV -------------------------------------------------------------------------

/**
 * One CSV field: quoted when it holds a comma, quote or line break, and with a
 * leading apostrophe when a spreadsheet would read it as a formula (=, +, -, @, tab, CR)
 * — file names and notes are user-controlled.
 */
export function csvField(v: unknown): string {
	if (v == null) return '';
	let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
	if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
	'id',
	'printer',
	'file',
	'path',
	'origin',
	'started_at',
	'ended_at',
	'duration_s',
	'result',
	'reason',
	'completion_pct',
	'filament_mm',
	'estimated_s',
	'started_by',
	'octoprint_user',
	'source',
	'notes',
	'filament_g',
	'material',
	'cost_filament',
	'cost_energy',
	'cost_total'
] as const;

/** The history as CSV (RFC 4180, CRLF line ends, with a header row). */
export function toCsv(records: PrintRecord[]): string {
	const round = (n: number | null, digits = 0) => (n == null ? null : Number(n.toFixed(digits)));
	const rows = records.map((r) =>
		[
			r.id,
			r.printerName,
			r.file,
			r.path,
			r.origin,
			r.startedAt,
			r.endedAt,
			round(r.durationS),
			r.result,
			r.reason,
			round(r.completion, 1),
			round(r.filamentMm, 1),
			round(r.estimatedS),
			r.startedBy,
			r.octoprintUser,
			r.source,
			r.notes,
			round(r.filamentG, 2),
			r.material,
			round(r.costFilament, 4),
			round(r.costEnergy, 4),
			round(r.cost, 4)
		]
			.map(csvField)
			.join(',')
	);
	return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}
