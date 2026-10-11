/**
 * Telling Spoolman how much filament each print used.
 *
 * Per print and tool, `spool_usage` keeps what the print has used so far (`target_mm`)
 * and how much of that Spoolman has been told (`reported_mm`). While a print runs, a
 * job estimates use from the job's analysis × progress (no extra OctoPrint requests:
 * it reads the live snapshot) and reports it in steps of a metre or more. When the print
 * ends, the final figure (the same analysis × how far it got as the history entry) is
 * reported. Failed reports stay pending and are retried by the job for a week.
 */
import { printers } from '../octoprint/manager.ts';
import { clientFor } from '../octoprint/manager.ts';
import { getKv, getPrinter, listPrinters, setKv, sqlite } from '../store.ts';
import { openPrints } from '../history/store.ts';
import { notify } from '../notify/index.ts';
import { listAssignments } from './assignments.ts';
import { needForFile, perToolMm } from './check.ts';
import { spoolmanConfigured, spoolmanSettings, useSpool } from './spoolman.ts';
import { remainingLabel, type SpoolSummary } from '#lib/spools.ts';
import type { PrintRecord } from '#lib/history.ts';

type Row = Record<string, unknown>;
const db = () => sqlite();

/** Below this, progressive reports wait for more (mm). */
export const STEP_MM = 1000;
const RETRY_DAYS = 7;

let chain: Promise<unknown> = Promise.resolve();
/** Runs Spoolman reporting one at a time, so the job and a print's end never report the same metre twice. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
	const next = chain.then(fn, fn);
	chain = next.catch(() => {});
	return next;
}

export interface UsageRow {
	printId: number;
	tool: number;
	spoolId: number;
	plannedMm: number | null;
	targetMm: number;
	reportedMm: number;
	final: boolean;
	lastError: string | null;
}

const toRow = (r: Row): UsageRow => ({
	printId: Number(r.print_id),
	tool: Number(r.tool),
	spoolId: Number(r.spool_id),
	plannedMm: typeof r.planned_mm === 'number' ? r.planned_mm : null,
	targetMm: Number(r.target_mm),
	reportedMm: Number(r.reported_mm),
	final: Number(r.final) === 1,
	lastError: (r.last_error as string) ?? null
});

export function usageRows(printId: number): UsageRow[] {
	return (db().prepare('SELECT * FROM spool_usage WHERE print_id = ? ORDER BY tool').all(printId) as Row[]).map(toRow);
}

/** Records use so far (never lowers it, never touches a final row). The spool is the one first seen for the print. */
function upsert(printId: number, tool: number, spoolId: number, plannedMm: number | null, targetMm: number, final = false) {
	db()
		.prepare(
			`INSERT INTO spool_usage (print_id, tool, spool_id, planned_mm, target_mm, final, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(print_id, tool) DO UPDATE SET
			   planned_mm = coalesce(excluded.planned_mm, planned_mm),
			   target_mm = CASE WHEN excluded.final = 1 THEN excluded.target_mm ELSE max(target_mm, excluded.target_mm) END,
			   final = max(final, excluded.final),
			   updated_at = excluded.updated_at
			 WHERE final = 0`
		)
		.run(printId, tool, spoolId, plannedMm, Math.max(0, targetMm), final ? 1 : 0, new Date().toISOString());
}

/** Reports what Spoolman hasn't heard yet, for rows at least `minMm` behind. */
async function flush(printId: number, minMm: number, printerId: string): Promise<void> {
	for (const r of usageRows(printId)) {
		const delta = Math.round((r.targetMm - r.reportedMm) * 100) / 100;
		if (delta < Math.max(minMm, 0.5)) continue;
		try {
			const spool = await useSpool(r.spoolId, delta);
			db().prepare('UPDATE spool_usage SET reported_mm = reported_mm + ?, last_error = NULL, updated_at = ? WHERE print_id = ? AND tool = ?').run(delta, new Date().toISOString(), printId, r.tool);
			if (spool) await checkLow(spool, printerId);
		} catch (err) {
			db().prepare('UPDATE spool_usage SET last_error = ?, updated_at = ? WHERE print_id = ? AND tool = ?').run((err as Error).message.slice(0, 300), new Date().toISOString(), printId, r.tool);
			console.warn(`[octo-modern] couldn’t report filament use to Spoolman (spool ${r.spoolId}): ${(err as Error).message}`);
		}
	}
}

// --- low spools ----------------------------------------------------------------------------

const LOW_KEY = 'spoolman:low-notified';

/** Notifies once when a spool drops below the threshold (again after it was refilled or replaced). */
export async function checkLow(spool: SpoolSummary, printerId: string | null): Promise<boolean> {
	const threshold = spoolmanSettings().lowThresholdG;
	const notified = new Set(getKv<number[]>(LOW_KEY, []));
	const low = spool.remainingWeight != null && spool.remainingWeight < threshold;
	if (!low) {
		if (notified.delete(spool.id)) setKv(LOW_KEY, [...notified]);
		return false;
	}
	if (notified.has(spool.id)) return false;
	notified.add(spool.id);
	setKv(LOW_KEY, [...notified]);
	const printer = printerId ? getPrinter(printerId) : undefined;
	const what = `${spool.name}${spool.material ? ` (${spool.material})` : ''}`;
	await notify({
		kind: 'spool.low',
		title: `Spool low: ${what}`,
		message: `${what}${printer ? ` on ${printer.name}` : ''} is down to ${remainingLabel(spool)} (below ${threshold} g).`,
		printerId: printer?.id ?? null,
		printerName: printer?.name ?? null,
		fields: [{ label: 'Spool', value: what }, { label: 'Left', value: remainingLabel(spool) }],
		link: printer ? `/p/${encodeURIComponent(printer.id)}` : '/filament',
		dedupeKey: `spool:${spool.id}`,
		snapshot: false
	});
	return true;
}

// --- while printing --------------------------------------------------------------------------

/**
 * One pass of the job: estimate use of every running print on a printer with spools,
 * report it in steps (if progressive reporting is on), and retry failed final reports.
 */
export function trackUsage(): Promise<void> {
	return serial(async () => {
		if (!spoolmanConfigured()) return;
		const progressive = spoolmanSettings().progressive;
		for (const p of listPrinters()) {
			const assignments = listAssignments(p.id);
			if (!assignments.length) continue;
			const [open] = openPrints(p.id);
			if (!open) continue;
			const snap = printers.snapshot(p.id);
			if (!snap?.job?.file || snap.job.file.path !== open.path) continue;
			const planned = perToolMm(snap.job.filament);
			const completion = Math.max(0, Math.min(100, snap.progress?.completion ?? 0));
			for (const a of assignments) {
				const mm = planned[a.tool];
				if (mm != null) upsert(open.id, a.tool, a.spoolId, mm, (mm * completion) / 100);
			}
			if (progressive) await flush(open.id, STEP_MM, p.id);
		}
		// Final reports that didn't get through.
		const since = new Date(Date.now() - RETRY_DAYS * 86_400_000).toISOString();
		const pending = db()
			.prepare(
				`SELECT DISTINCT u.print_id, p.printer_id FROM spool_usage u JOIN prints p ON p.id = u.print_id
				 WHERE u.final = 1 AND u.target_mm - u.reported_mm >= 0.5 AND u.updated_at >= ?`
			)
			.all(since) as Row[];
		for (const r of pending) await flush(Number(r.print_id), 0, r.printer_id as string);
	});
}

// --- when a print ends ------------------------------------------------------------------------

/** One tool's share of a finished print, with the spool it came from (if any). */
export interface ToolShare {
	tool: number;
	mm: number;
	spoolId: number | null;
}

/**
 * Settles a finished print's use per tool, reports it to Spoolman, and returns the
 * shares (for costing). Empty when the print's filament is unknown.
 */
export function finishUsage(record: PrintRecord): Promise<ToolShare[]> {
	return serial(async () => {
		const completion = record.result === 'success' ? 100 : Math.max(0, Math.min(100, record.completion ?? 0));
		const rows = usageRows(record.id);
		// Per-tool analysis: what the job saw while printing, else the live job, else the file on OctoPrint.
		let planned: Record<number, number> = {};
		for (const r of rows) if (r.plannedMm != null) planned[r.tool] = r.plannedMm;
		if (!Object.keys(planned).length) {
			const job = printers.snapshot(record.printerId)?.job;
			if (job?.file?.path === record.path) planned = perToolMm(job.filament);
		}
		const printer = getPrinter(record.printerId);
		if (!Object.keys(planned).length && printer && spoolmanConfigured() && listAssignments(record.printerId).length) {
			planned = (await needForFile(clientFor(printer), record.origin, record.path))?.perTool ?? {};
		}
		let shares: ToolShare[];
		const spoolOf = new Map<number, number>(rows.map((r) => [r.tool, r.spoolId]));
		for (const a of listAssignments(record.printerId)) if (!spoolOf.has(a.tool)) spoolOf.set(a.tool, a.spoolId);
		if (Object.keys(planned).length) {
			shares = Object.entries(planned).map(([t, mm]) => ({ tool: Number(t), mm: (mm * completion) / 100, spoolId: spoolOf.get(Number(t)) ?? null }));
			// Keep the total in line with the history entry (it may come from a fresher analysis).
			const sum = shares.reduce((s, x) => s + x.mm, 0);
			if (record.filamentMm != null && sum > 0 && Math.abs(sum - record.filamentMm) > 1) for (const s of shares) s.mm = (s.mm / sum) * record.filamentMm;
		} else if (record.filamentMm != null && record.filamentMm > 0) {
			shares = [{ tool: 0, mm: record.filamentMm, spoolId: spoolOf.get(0) ?? null }];
		} else shares = [];
		shares.sort((a, b) => a.tool - b.tool);
		if (!spoolmanConfigured()) return shares;
		for (const s of shares) if (s.spoolId != null) upsert(record.id, s.tool, s.spoolId, planned[s.tool] ?? null, s.mm, true);
		await flush(record.id, 0, record.printerId);
		return shares;
	});
}
