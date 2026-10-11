/**
 * The Stats page's numbers, aggregated in SQL over the `prints` table: totals, print
 * time per bucket and printer, outcomes per bucket, most-printed files, failure
 * reasons, utilisation per printer, filament per material and per Spoolman spool.
 *
 * Bucket bounds come from buckets.ts (time-zone aware) and are joined in as a VALUES
 * table, so SQLite only compares ISO strings and can use the started_at indexes.
 */
import { sqlite, listPrinters } from '../store.ts';
import { costSettings } from '../costs.ts';
import { spoolmanConfigured, spoolsById } from '../spools/spoolman.ts';
import { makeBuckets, rangeStart } from './buckets.ts';
import { gramsFromMm, materialOf } from '#lib/spools.ts';
import type { SpoolSummary } from '#lib/spools.ts';
import type { FileStats, MaterialStats, ReasonStats, SpoolStats, StatsBucket, StatsPrinter, StatsRange, StatsReport, Utilisation } from '#lib/stats.ts';

type Row = Record<string, unknown>;
type Value = string | number | null;
const db = () => sqlite();
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const FINISHED = `result IN ('success', 'failed', 'cancelled')`;

export interface ReportQuery {
	range: StatsRange;
	/** Printer ids the user may see; null for admins (every printer, removed ones too). */
	scope: string[] | null;
	/** One printer, already checked against the scope. */
	printer?: string | null;
	timeZone: string;
	now?: number;
	/** Top files to list. */
	files?: number;
}

/** `WHERE` for the scope and printer filter (no time bound). */
function scopeWhere(q: Pick<ReportQuery, 'scope' | 'printer'>, alias = ''): { sql: string; values: Value[] } {
	const col = `${alias}printer_id`;
	const w: string[] = [];
	const values: Value[] = [];
	if (q.scope) {
		if (!q.scope.length) return { sql: '0', values };
		w.push(`${col} IN (${q.scope.map(() => '?').join(',')})`);
		values.push(...q.scope);
	}
	if (q.printer) w.push(`${col} = ?`), values.push(q.printer);
	return { sql: w.length ? w.join(' AND ') : '1', values };
}

/**
 * The printers for the picker and the series colours (also with a printer filter, so a
 * printer keeps its colour): the user's printers, then removed ones with prints in the range (admins).
 */
function reportPrinters(q: ReportQuery, from: string | null): StatsPrinter[] {
	const current = listPrinters().filter((p) => !q.scope || q.scope.includes(p.id));
	const out: StatsPrinter[] = current.map((p) => ({ id: p.id, name: p.name, removed: false }));
	if (!q.scope) {
		const ids = new Set(out.map((p) => p.id));
		const seen = db().prepare(`SELECT DISTINCT printer_id FROM prints WHERE started_at >= ?`).all(from ?? '') as Row[];
		const nameOf = db().prepare(`SELECT printer_name FROM prints WHERE printer_id = ? ORDER BY started_at DESC LIMIT 1`);
		const removed = seen
			.map((r) => r.printer_id as string)
			.filter((id) => !ids.has(id))
			.map((id) => ({ id, name: ((nameOf.get(id) as Row | undefined)?.printer_name as string) ?? id, removed: true }));
		out.push(...removed.sort((x, y) => x.name.localeCompare(y.name)));
	}
	return out;
}

export async function statsReport(q: ReportQuery): Promise<StatsReport> {
	const now = q.now ?? Date.now();
	const nowIso = new Date(now).toISOString();
	const scope = scopeWhere(q);
	const settings = costSettings();
	const gPerMm = gramsFromMm(1, materialOf(settings, settings.defaultMaterial).density, settings.diameter);

	let firstPrint: number | null = null;
	if (q.range === 'all') {
		const r = db().prepare(`SELECT min(started_at) AS first FROM prints WHERE ${scope.sql}`).get(...scope.values) as Row;
		firstPrint = typeof r.first === 'string' ? Date.parse(r.first) : null;
	}
	const { from: fromMs, granularity } = rangeStart(q.range, now, q.timeZone, firstPrint);
	const from = fromMs == null ? null : new Date(fromMs).toISOString();
	const rangeSecs = fromMs == null ? 0 : Math.max(0, (now - fromMs) / 1000);
	// Every query: the user's printers, started within the range.
	const where = `${scope.sql} AND started_at >= ? AND started_at <= ?`;
	const values: Value[] = [...scope.values, from ?? nowIso, nowIso];

	// Totals.
	const t = db()
		.prepare(
			`SELECT count(*) AS prints,
			   sum(result = 'success') AS success, sum(result = 'failed') AS failed, sum(result = 'cancelled') AS cancelled,
			   coalesce(sum(duration_s), 0) AS secs, avg(duration_s) AS avg_secs,
			   coalesce(sum(filament_mm), 0) AS mm, coalesce(sum(coalesce(filament_g, filament_mm * ?)), 0) AS grams,
			   coalesce(sum(coalesce(cost_filament, 0) + coalesce(cost_energy, 0)), 0) AS cost,
			   sum(cost_filament IS NOT NULL OR cost_energy IS NOT NULL) AS costed
			 FROM prints WHERE ${where} AND ${FINISHED}`
		)
		.get(gPerMm, ...values) as Row;
	const prints = num(t.prints);
	const success = num(t.success);
	const totals = {
		prints,
		success,
		failed: num(t.failed),
		cancelled: num(t.cancelled),
		successRate: prints ? success / prints : null,
		printTime: num(t.secs),
		avgPrintTime: typeof t.avg_secs === 'number' ? t.avg_secs : null,
		filamentMm: num(t.mm),
		filamentG: num(t.grams),
		cost: Math.round(num(t.cost) * 100) / 100,
		costed: num(t.costed),
		currency: settings.currency
	};

	// Buckets: print time per printer, and outcomes.
	const buckets: StatsBucket[] = [];
	if (fromMs != null) {
		const bs = makeBuckets(fromMs, now + 1, granularity, q.timeZone);
		const byKey = new Map<string, StatsBucket>();
		for (const b of bs) {
			const sb: StatsBucket = { key: b.key, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), printTime: {}, success: 0, failed: 0, cancelled: 0 };
			buckets.push(sb);
			byKey.set(b.key, sb);
		}
		if (bs.length) {
			const cte = bs.map(() => '(?, ?, ?)').join(', ');
			// The first bucket is clipped to the range (a week or month can start before it), so the
			// buckets alone bound the query: one index range per bucket.
			const cteValues = bs.flatMap((b) => [b.key, new Date(Math.max(b.start, fromMs)).toISOString(), new Date(b.end).toISOString()]);
			const rows = db()
				.prepare(
					`WITH b(k, s, e) AS (VALUES ${cte})
					 SELECT b.k AS bucket, p.printer_id AS printer, p.result AS result, count(*) AS n, coalesce(sum(p.duration_s), 0) AS secs
					 FROM b CROSS JOIN prints p ON p.started_at >= b.s AND p.started_at < b.e
					 WHERE ${scopeWhere(q, 'p.').sql} AND p.${FINISHED}
					 GROUP BY b.k, p.printer_id, p.result`
				)
				.all(...cteValues, ...scope.values) as Row[];
			for (const r of rows) {
				const b = byKey.get(r.bucket as string);
				if (!b) continue;
				const res = r.result as 'success' | 'failed' | 'cancelled';
				b[res] += num(r.n);
				const pid = r.printer as string;
				b.printTime[pid] = (b.printTime[pid] ?? 0) + num(r.secs);
			}
		}
	}

	// Most-printed files.
	const files: FileStats[] = (
		db()
			.prepare(
				// The bare file_name and printer_id come from the row with max(started_at) (SQLite's rule for a single max()).
				`SELECT file_path AS path, file_name AS file, printer_id AS printer, max(started_at) AS last, count(*) AS prints, sum(result = 'success') AS success,
				   coalesce(avg(CASE WHEN result = 'success' THEN duration_s END), avg(duration_s)) AS avg_secs
				 FROM prints WHERE ${where} AND ${FINISHED}
				 GROUP BY file_path ORDER BY prints DESC, last DESC LIMIT ?`
			)
			.all(...values, q.files ?? 10) as Row[]
	).map((r) => ({
		path: r.path as string,
		file: r.file as string,
		prints: num(r.prints),
		success: num(r.success),
		successRate: num(r.prints) ? num(r.success) / num(r.prints) : null,
		avgPrintTime: typeof r.avg_secs === 'number' ? r.avg_secs : null,
		lastPrinted: r.last as string,
		printerId: r.printer as string
	}));

	// Why prints didn't succeed.
	const reasons: ReasonStats[] = (
		db()
			.prepare(
				`SELECT result, nullif(trim(reason), '') AS reason, count(*) AS n FROM prints
				 WHERE ${where} AND result IN ('failed', 'cancelled') GROUP BY result, nullif(trim(reason), '') ORDER BY n DESC, result, reason`
			)
			.all(...values) as Row[]
	).map((r) => ({ result: r.result as 'failed' | 'cancelled', reason: (r.reason as string) ?? null, count: num(r.n) }));

	// Utilisation: printing time inside [from, now], clipped at both ends. A print's end
	// is its start + print time, else its end, else now while it runs.
	const utilisation: Utilisation[] = [];
	if (fromMs != null && rangeSecs > 0) {
		const rows = db()
			.prepare(
				`SELECT printer_id AS printer, sum(max(0, min(
				   coalesce(julianday(started_at) + duration_s / 86400.0, julianday(ended_at), CASE WHEN result IN ('printing', 'paused') THEN julianday(?) END, julianday(started_at)),
				   julianday(?)) - max(julianday(started_at), julianday(?)))) * 86400 AS secs
				 FROM prints WHERE ${scope.sql} AND started_at <= ? AND started_at >= ?
				 GROUP BY printer_id`
			)
			// Prints that started up to a week before the range can still overlap it (and the clip ignores the rest).
			.all(nowIso, nowIso, from, ...scope.values, nowIso, new Date(fromMs - 7 * 86_400_000).toISOString()) as Row[];
		for (const r of rows) {
			// julianday() is a float: round to whole seconds.
			const secs = Math.min(Math.round(num(r.secs)), rangeSecs);
			if (secs > 0) utilisation.push({ printerId: r.printer as string, printSecs: secs, share: secs / rangeSecs });
		}
		utilisation.sort((a, b) => b.share - a.share);
	}

	// Filament per material (entries costed before carry one; the rest count as the default material).
	const materials: MaterialStats[] = (
		db()
			.prepare(
				`SELECT coalesce(material, ?) AS material, count(*) AS n, coalesce(sum(filament_mm), 0) AS mm, coalesce(sum(coalesce(filament_g, filament_mm * ?)), 0) AS g
				 FROM prints WHERE ${where} AND ${FINISHED} AND (filament_mm > 0 OR filament_g > 0) GROUP BY 1 ORDER BY g DESC`
			)
			.all(settings.defaultMaterial, gPerMm, ...values) as Row[]
	).map((r) => ({ material: r.material as string, prints: num(r.n), filamentMm: num(r.mm), filamentG: num(r.g) }));

	// Filament per Spoolman spool, from what was reported per print and tool.
	let spools: SpoolStats[] | null = null;
	if (spoolmanConfigured()) {
		const rows = db()
			.prepare(
				`SELECT u.spool_id AS spool, count(DISTINCT u.print_id) AS n, sum(u.target_mm) AS mm FROM spool_usage u JOIN prints p ON p.id = u.print_id
				 WHERE ${scopeWhere(q, 'p.').sql} AND p.started_at >= ? AND p.started_at <= ? GROUP BY u.spool_id HAVING mm > 0 ORDER BY mm DESC`
			)
			.all(...scope.values, from ?? nowIso, nowIso) as Row[];
		if (rows.length) {
			let known = new Map<number, SpoolSummary>();
			try {
				known = await withTimeout(
					spoolsById(rows.map((r) => Number(r.spool))),
					3000
				);
			} catch {
				// Spoolman unreachable: the spools are still listed, by number.
			}
			spools = rows.map((r) => {
				const s = known.get(Number(r.spool));
				const mm = num(r.mm);
				return {
					spoolId: Number(r.spool),
					name: s?.name ?? null,
					vendor: s?.vendor ?? null,
					material: s?.material ?? null,
					color: s?.color ?? null,
					prints: num(r.n),
					filamentMm: mm,
					filamentG: s ? gramsFromMm(mm, s.density, s.diameter) : gramsFromMm(mm, materialOf(settings, settings.defaultMaterial).density, settings.diameter)
				};
			});
		}
	}

	return {
		range: q.range,
		granularity,
		timeZone: q.timeZone,
		from,
		to: nowIso,
		rangeSecs,
		printers: reportPrinters(q, from),
		totals,
		buckets,
		files,
		reasons,
		utilisation,
		materials,
		spools
	};
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('timeout')), ms);
		p.then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e))
		);
	});
}
