/**
 * The MCP server's tools. Each one is a thin layer over what the app already does
 * (status.ts, the backends, history, queue, maintenance, plugins, spools, and the shared
 * printer actions in printer-actions.ts), checked against the token's context
 * (principal.ts) first.
 *
 * - Read tools are offered to every MCP token. `get_updates_available` only when the
 *   token's creator is an admin (plugin updates are admin-only in the app too).
 * - Control tools are offered only to `control` tokens whose creator is (still) an
 *   operator or admin; read-only tokens don't see them in tools/list at all, and calling
 *   one anyway is refused. Each checks the printer again at call time.
 * - Dangerous actions (cancel_print, start_print) do nothing without `confirm: true`:
 *   they answer with what would happen instead.
 * - Every control call is audit-logged as the creator, "via MCP token “Name”".
 */
import { OctoPrintError } from '../octoprint/errors.ts';
import { BadRequest, Forbidden, NotFound } from '../http.ts';
import { printers as manager } from '../octoprint/manager.ts';
import { backendFor } from '../backend/index.ts';
import { currentState, viewTarget } from '../control.ts';
import { statusItem } from '../status.ts';
import { fetchSnapshot } from '../octoprint/webcam.ts';
import { jobCommand, printFile, setTemperatures, type ActionOutcome } from '../printer-actions.ts';
import { addQueueJob, confirmBedClear, queueState } from '../queue/service.ts';
import { getQueuePrinter } from '../queue/store.ts';
import { prep } from '../preprint/service.ts';
import { prepConfigured } from '../preprint/settings.ts';
import { historyScope } from '../history/access.ts';
import { listPrints } from '../history/store.ts';
import { statsReport } from '../history/report.ts';
import { serverTimeZone } from '../history/buckets.ts';
import { listTasks } from '../maintenance.ts';
import { cachedUpdates } from '../plugins.ts';
import { printerSpools } from '../spools/assignments.ts';
import { listSpools, spoolmanConfigured } from '../spools/spoolman.ts';
import { listFolder, requireSource, searchFolder, visibleSources } from '../library/service.ts';
import { canUsePrinter, inScope, mayControl, resolvePrinter, scopedPrinters, ToolError, type McpContext } from './principal.ts';
import { heaterKeys, jobActive, STATE_LABEL, type LiveSnapshot } from '#lib/printer.ts';
import { RESULTS, type PrintResult } from '#lib/history.ts';
import { STATS_RANGES, type StatsRange } from '#lib/stats.ts';
import type { FileEntry, Printer } from '#lib/types.ts';
import type { LibrarySourceSummary } from '#lib/library.ts';

type Json = Record<string, unknown>;
type Schema = Json;

export interface ToolResult {
	content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
	structuredContent?: Json;
	isError?: boolean;
	[key: string]: unknown;
}

export interface ToolDef {
	name: string;
	title: string;
	description: string;
	inputSchema: Schema;
	annotations: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
	/** Changes something: only for control tokens of operators and admins. */
	control: boolean;
	/** Only offered when the creator is an admin. */
	admin?: boolean;
	run(ctx: McpContext, args: Json): Promise<ToolResult>;
}

// --- results -----------------------------------------------------------------------------------

/** Structured content, with the same JSON as text for clients that only read text. */
export function ok(data: Json): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

export function fail(message: string, data?: Json): ToolResult {
	const body = { error: message, ...data };
	return { content: [{ type: 'text', text: data ? `${message}\n\n${JSON.stringify(data, null, 2)}` : message }], structuredContent: body, isError: true };
}

/** Errors from the app (not found, refused, printer unreachable…) as tool errors the model can read. */
export function errorResult(err: unknown): ToolResult {
	if (err instanceof ToolError) return fail(err.message, err.data);
	if (err instanceof NotFound || err instanceof BadRequest || err instanceof Forbidden) return fail(err.message);
	if (err instanceof OctoPrintError) return fail(err.message, { ...(err.code ? { code: err.code } : {}), ...(err.hint ? { hint: err.hint } : {}) });
	console.error('[octo-modern] MCP tool failed', err);
	return fail(`Something went wrong: ${(err as Error)?.message ?? String(err)}`);
}

// --- arguments -----------------------------------------------------------------------------------

const str = (args: Json, key: string): string | undefined => {
	const v = args[key];
	if (v === undefined || v === null || v === '') return undefined;
	if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string`);
	return v.trim();
};
const num = (args: Json, key: string, min: number, max: number, fallback: number): number => {
	const v = args[key];
	if (v === undefined || v === null) return fallback;
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n) || n < min || n > max) throw new ToolError(`"${key}" must be a number from ${min} to ${max}`);
	return n;
};

const PRINTER = { type: 'string', description: 'Printer name or id (case-insensitive name match; see list_printers).' };
const obj = (properties: Json, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });

// --- shapes --------------------------------------------------------------------------------------

const round = (n: number | null | undefined, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

function temps(s: LiveSnapshot) {
	return Object.fromEntries(heaterKeys(s.temps).map((k) => [k, { actual: round(s.temps[k].actual), target: round(s.temps[k].target) }]));
}

function brief(ctx: McpContext, p: Printer, s: LiveSnapshot) {
	const item = statusItem(p, s, false);
	return {
		id: p.id,
		name: p.name,
		kind: p.kind ?? 'octoprint',
		state: item.state,
		stateLabel: item.stateLabel,
		online: item.online,
		progressPercent: item.progress,
		file: item.file,
		printTimeSeconds: item.printTimeSeconds,
		timeLeftSeconds: item.printTimeLeftSeconds,
		eta: item.eta,
		temperatures: temps(s),
		...(s.preparing ? { preparing: s.preparing.label } : {}),
		...(item.error ? { error: item.error } : {}),
		canControl: canUsePrinter(ctx, p, 'control')
	};
}

async function snapshotOf(p: Printer): Promise<LiveSnapshot> {
	const [s] = await manager.snapshots([p.id]);
	return s;
}

/** Every file below a printer's file tree, flattened. */
function flatten(entries: FileEntry[], out: FileEntry[] = []): FileEntry[] {
	for (const e of entries) {
		out.push(e);
		if (e.children) flatten(e.children, out);
	}
	return out;
}

const fileView = (f: FileEntry) => ({
	path: f.path,
	name: f.display || f.name,
	type: f.type,
	origin: f.origin,
	...(f.type !== 'folder'
		? { size: f.size, uploaded: f.date ? new Date(f.date * 1000).toISOString() : null, estimatedPrintSeconds: f.estimatedPrintTime, filamentMm: round(f.filamentMm, 0), lastPrint: f.prints?.lastDate ? { success: f.prints.lastSuccess, at: new Date(f.prints.lastDate * 1000).toISOString() } : null }
		: {})
});

/** What's directly in a folder ('' = the top), with folders made up for files deeper down (some servers list files flat). */
function folderEntries(all: FileEntry[], folder: string): FileEntry[] {
	const prefix = folder ? `${folder}/` : '';
	const out = new Map<string, FileEntry>();
	for (const f of all) {
		if (!f.path.startsWith(prefix) || f.path === folder) continue;
		const rest = f.path.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash < 0) {
			if (!out.has(f.path)) out.set(f.path, f);
			continue;
		}
		const path = prefix + rest.slice(0, slash);
		if (!out.has(path)) out.set(path, { origin: f.origin, path, name: rest.slice(0, slash), display: rest.slice(0, slash), type: 'folder', size: null, date: null, estimatedPrintTime: null, filamentMm: null, thumbnail: null, prints: null });
	}
	return [...out.values()].map((f) => (f.children ? { ...f, children: undefined } : f));
}

/** Words all found in the name or path (case-insensitive). */
const matchesAll = (text: string, q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w));

/** A printable file on the printer by path, or by a name that picks out one file. */
async function resolvePrinterFile(p: Printer, ref: string, origin?: 'local' | 'sdcard'): Promise<FileEntry> {
	const want = ref.replace(/^\/+/, '');
	if (!want || want.split('/').includes('..')) throw new ToolError('"file" must be a path on the printer, e.g. "parts/benchy.gcode"');
	const files = flatten((await backendFor(p).files()).files).filter((f) => f.type === 'machinecode' && (!origin || f.origin === origin));
	let hits = files.filter((f) => f.path === want);
	if (!hits.length) hits = files.filter((f) => f.path.toLowerCase() === want.toLowerCase() || (f.display || f.name).toLowerCase() === want.toLowerCase() || f.name.toLowerCase() === want.toLowerCase());
	if (!hits.length) hits = files.filter((f) => matchesAll(`${f.path} ${f.display}`, want.replace(/\.(gcode|gco|g|bgcode)$/i, '')));
	if (!hits.length) throw new ToolError(`${p.name} has no G-code file matching “${ref}”. Use list_files with printer “${p.name}” to see its files.`);
	if (hits.length > 1) throw new ToolError(`“${ref}” matches ${hits.length} files on ${p.name}; pass the exact path.`, { matches: hits.slice(0, 20).map((f) => f.path) });
	return hits[0];
}

/** Library sources this call may use: visible to the creator, and (for printer-limited tokens) open to one of its printers. */
function sources(ctx: McpContext): LibrarySourceSummary[] {
	const all = visibleSources(ctx.user);
	if (ctx.printers === 'all') return all;
	return all.filter((s) => s.printers.some((id) => inScope(ctx, id)));
}

function resolveSource(ctx: McpContext, ref: string): LibrarySourceSummary {
	const list = sources(ctx);
	const want = ref.toLowerCase();
	const hits = list.filter((s) => s.id === ref).length ? list.filter((s) => s.id === ref) : list.filter((s) => s.name.toLowerCase() === want || s.name.toLowerCase().startsWith(want));
	if (hits.length === 1) return hits[0];
	const names = list.map((s) => `“${s.name}”`).join(', ') || '(none)';
	throw new ToolError(hits.length ? `“${ref}” matches several library sources: ${names}` : `No library source “${ref}”. Sources: ${names}`);
}

/** Printer ids for history and stats: the creator's (null = all, admins) cut down to the token's printers. */
function historyIds(ctx: McpContext): string[] | null {
	const scope = historyScope(ctx.user);
	if (ctx.printers === 'all') return scope;
	return (scope ?? ctx.printers).filter((id) => ctx.printers.includes(id));
}

const outcome = (o: ActionOutcome, done: Json): ToolResult => {
	if (o.ok) return ok({ ...done, ...(o.preparing ? { preparing: true, note: 'The pre-print steps run first; the file starts once they finish (the printer shows “Preparing”).' } : {}) });
	const c = o.confirm;
	if (c.preprint) {
		return ok({
			done: false,
			needs: 'preprint',
			message: `${c.message} Call start_print again with the same arguments plus preprint: "run" (do the steps marked run) or "skip" (start the file right away).`,
			steps: c.preprint.steps
		});
	}
	return ok({ done: false, needs: 'filament', message: `${c.message} Ask the user; to print anyway call start_print again with ignore_filament_warning: true.` });
};

// --- the tools -------------------------------------------------------------------------------------

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS: ToolDef[] = [
	{
		name: 'list_printers',
		title: 'List printers',
		description: 'Every printer this token can see, with its state (printing, idle, offline…), job progress, time left/ETA and temperatures.',
		inputSchema: obj({}),
		annotations: { title: 'List printers', ...READ },
		control: false,
		async run(ctx) {
			const list = scopedPrinters(ctx);
			const snaps = await manager.snapshots(list.map((p) => p.id));
			const items = list.map((p, i) => brief(ctx, p, snaps[i]));
			return ok({ printers: items, count: items.length, printing: items.filter((i) => i.state === 'printing').length, checkedAt: new Date().toISOString() });
		}
	},
	{
		name: 'get_printer_status',
		title: 'Printer status',
		description: 'A detailed live snapshot of one printer: state and error, job (file, progress, elapsed, left, ETA, filament), temperatures, Z height, pre-print steps running, queue state (bed awaiting clear, held).',
		inputSchema: obj({ printer: PRINTER }, ['printer']),
		annotations: { title: 'Printer status', ...READ },
		control: false,
		async run(ctx, args) {
			const p = resolvePrinter(ctx, args.printer);
			const s = await snapshotOf(p);
			const q = getQueuePrinter(p.id);
			return ok({
				...brief(ctx, p, s),
				stateText: s.stateText,
				printerError: s.printerError,
				problem: s.problem ? { message: s.problem.message, ...(s.problem.hint ? { hint: s.problem.hint } : {}) } : null,
				job: s.job?.file?.path
					? {
							file: s.job.file.display || s.job.file.name,
							path: s.job.file.path,
							origin: s.job.file.origin,
							estimatedPrintSeconds: s.job.estimatedPrintTime,
							filamentMeters: statusItem(p, s, false).filamentMeters,
							user: s.job.user
						}
					: null,
				currentZ: s.currentZ,
				preparing: s.preparing ?? null,
				queue: { bedAwaitingClear: q.awaitingClear, awaitingSince: q.awaitingSince, held: q.held, heldReason: q.heldReason },
				version: s.version,
				lastUpdatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null
			});
		}
	},
	{
		name: 'get_camera_snapshot',
		title: 'Camera snapshot',
		description: 'A current picture from the printer’s webcam (JPEG or PNG). Optionally pick a camera by id when the printer has several.',
		inputSchema: obj({ printer: PRINTER, camera: { type: 'string', description: 'Camera id (default: the first camera).' } }, ['printer']),
		annotations: { title: 'Camera snapshot', ...READ, idempotentHint: false },
		control: false,
		async run(ctx, args) {
			const p = resolvePrinter(ctx, args.printer);
			const { type, res } = await fetchSnapshot(p, str(args, 'camera'));
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length > 8 * 1024 * 1024) throw new ToolError('The snapshot is larger than 8 MB');
			return {
				content: [
					{ type: 'image', data: buf.toString('base64'), mimeType: type || 'image/jpeg' },
					{ type: 'text', text: `Webcam snapshot of ${p.name} at ${new Date().toISOString()} (${STATE_LABEL[(manager.snapshot(p.id)?.state ?? 'unknown')].toLowerCase()}).` }
				],
				structuredContent: { printer: p.name, mimeType: type, bytes: buf.length, at: new Date().toISOString() }
			};
		}
	},
	{
		name: 'list_files',
		title: 'List or search files',
		description:
			'With `printer`: the G-code files on that printer (a folder with `path`, or all files matching `search`). Without: the shared library (NAS/network sources): a folder of `source` (name or id), or files matching `search` across sources. Without arguments: the library sources.',
		inputSchema: obj({
			printer: PRINTER,
			source: { type: 'string', description: 'Library source name or id (library only).' },
			path: { type: 'string', description: 'Folder to list, e.g. "parts" ("" = top level).' },
			search: { type: 'string', description: 'Words that must all appear in the file name or path (at least 2 characters).' }
		}),
		annotations: { title: 'List or search files', ...READ },
		control: false,
		async run(ctx, args) {
			const search = str(args, 'search');
			const path = (str(args, 'path') ?? '').replace(/^\/+|\/+$/g, '');
			if (search !== undefined && search.length < 2) throw new ToolError('Search for at least 2 characters');
			if (args.printer !== undefined) {
				const p = resolvePrinter(ctx, args.printer);
				const { backend } = viewTarget(ctx.user, p.id);
				const listing = await backend.files();
				const all = flatten(listing.files);
				let list: FileEntry[];
				if (search) list = all.filter((f) => f.type !== 'folder' && matchesAll(`${f.path} ${f.display}`, search));
				else {
					list = folderEntries(all, path);
					if (path && !list.length) throw new ToolError(`${p.name} has no folder “${path}”`);
				}
				return ok({ printer: p.name, path: search ? null : path, search: search ?? null, files: list.slice(0, 300).map(fileView), total: list.length, truncated: list.length > 300, freeBytes: listing.free });
			}
			const srcs = sources(ctx);
			const srcRef = str(args, 'source');
			if (!srcRef) {
				if (search) {
					const results = [];
					let truncated = false;
					for (const s of srcs) {
						const r = await searchFolder(requireSource(ctx.user, s.id), '', search.slice(0, 100));
						truncated ||= r.truncated;
						results.push(...r.results.map((e) => ({ source: s.name, path: e.path, name: e.name, type: e.type, size: e.size, modified: e.mtime ? new Date(e.mtime).toISOString() : null })));
					}
					return ok({ library: true, search, files: results.slice(0, 300), total: results.length, truncated: truncated || results.length > 300 });
				}
				if (srcs.length !== 1) return ok({ library: true, sources: srcs.map((s) => ({ id: s.id, name: s.name, kind: s.kind, writable: s.writable })), note: 'Pass `source` to list a folder, or `search` to find files.' });
			}
			const s = srcRef ? resolveSource(ctx, srcRef) : srcs[0];
			const src = requireSource(ctx.user, s.id);
			if (search) {
				const r = await searchFolder(src, path, search.slice(0, 100));
				return ok({ library: true, source: s.name, path, search, files: r.results.map((e) => ({ path: e.path, name: e.name, type: e.type, size: e.size, modified: e.mtime ? new Date(e.mtime).toISOString() : null })), truncated: r.truncated });
			}
			const l = await listFolder(src, path);
			return ok({
				library: true,
				source: s.name,
				path: l.path,
				files: l.entries.slice(0, 300).map((e) => ({ path: e.path, name: e.name, type: e.type, size: e.size, modified: e.mtime ? new Date(e.mtime).toISOString() : null, ...(e.meta ? { estimatedPrintSeconds: e.meta.estimatedTime, filamentMm: e.meta.filamentMm } : {}) })),
				truncated: l.entries.length > 300
			});
		}
	},
	{
		name: 'get_queue',
		title: 'Print queue',
		description: 'The print queue: jobs (waiting, printing, held, done…) with their target printer, and per printer whether its bed awaits a “bed is clear” confirmation or dispatch is held.',
		inputSchema: obj({}),
		annotations: { title: 'Print queue', ...READ },
		control: false,
		async run(ctx) {
			const s = queueState(ctx.user);
			const names = new Map(scopedPrinters(ctx).map((p) => [p.id, p.name]));
			const jobs = s.jobs
				.filter((j) => !j.printerId || names.has(j.printerId))
				.map((j) => ({
					id: j.id,
					name: j.name,
					status: j.status,
					printer: j.printerId ? names.get(j.printerId) : 'any printer',
					...(j.tags.length ? { tags: j.tags } : {}),
					copies: j.copies,
					done: j.done,
					source: j.source === 'library' ? `library: ${j.sourceName}` : j.source,
					...(j.activePrinterId ? { runningOn: names.get(j.activePrinterId) ?? j.activePrinterId } : {}),
					...(j.error ? { error: j.error } : {}),
					addedBy: j.createdBy,
					addedAt: j.createdAt
				}));
			const printers = s.printers.filter((p) => names.has(p.printerId)).map((p) => ({ printer: names.get(p.printerId), bedAwaitingClear: p.awaitingClear, held: p.held, heldReason: p.heldReason, waitingJobs: p.waiting, tags: p.tags }));
			return ok({ paused: s.paused, jobs, printers });
		}
	},
	{
		name: 'get_print_history',
		title: 'Print history',
		description: 'Recent prints, newest first: file, printer, result (success, failed, cancelled…), start/end, duration, filament, cost, who started it.',
		inputSchema: obj({
			limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'How many (1–100, default 20).' },
			printer: PRINTER,
			result: { type: 'string', enum: RESULTS, description: 'Only prints with this result.' },
			search: { type: 'string', description: 'Text in the file name, notes, printer or user.' }
		}),
		annotations: { title: 'Print history', ...READ },
		control: false,
		async run(ctx, args) {
			const limit = Math.round(num(args, 'limit', 1, 100, 20));
			const printer = args.printer !== undefined ? resolvePrinter(ctx, args.printer) : null;
			const result = str(args, 'result');
			if (result && !RESULTS.includes(result as PrintResult)) throw new ToolError(`"result" must be one of ${RESULTS.join(', ')}`);
			const items = listPrints({ printerIds: historyIds(ctx), printer: printer?.id, result: result as PrintResult | undefined, q: str(args, 'search')?.slice(0, 200), limit });
			return ok({
				prints: items.map((r) => ({
					id: r.id,
					printer: r.printerName,
					file: r.file,
					path: r.path,
					result: r.result,
					...(r.reason ? { reason: r.reason } : {}),
					startedAt: r.startedAt,
					endedAt: r.endedAt,
					durationSeconds: r.durationS,
					completionPercent: round(r.completion),
					filamentG: round(r.filamentG),
					...(r.material ? { material: r.material } : {}),
					...(r.cost != null ? { cost: round(r.cost, 2) } : {}),
					startedBy: r.startedBy,
					...(r.notes ? { notes: r.notes } : {})
				}))
			});
		}
	},
	{
		name: 'get_stats',
		title: 'Print statistics',
		description: 'Totals for a period: prints, success rate, print time, filament, cost; per printer utilisation; most printed files; failure reasons; materials.',
		inputSchema: obj({ range: { type: 'string', enum: STATS_RANGES, default: '30d', description: '30d, 90d, 12m or all.' }, printer: PRINTER }),
		annotations: { title: 'Print statistics', ...READ },
		control: false,
		async run(ctx, args) {
			const raw = str(args, 'range') ?? '30d';
			if (!STATS_RANGES.includes(raw as StatsRange)) throw new ToolError(`"range" must be one of ${STATS_RANGES.join(', ')}`);
			const printer = args.printer !== undefined ? resolvePrinter(ctx, args.printer) : null;
			const r = await statsReport({ range: raw as StatsRange, scope: historyIds(ctx), printer: printer?.id ?? null, timeZone: serverTimeZone() });
			const name = new Map(r.printers.map((p) => [p.id, p.name]));
			return ok({
				range: r.range,
				from: r.from,
				to: r.to,
				totals: r.totals,
				utilisation: r.utilisation.map((u) => ({ printer: name.get(u.printerId) ?? u.printerId, printSeconds: u.printSecs, sharePercent: round(u.share * 100) })),
				topFiles: r.files.slice(0, 10).map((f) => ({ file: f.file, prints: f.prints, successRate: f.successRate, avgPrintSeconds: f.avgPrintTime })),
				failureReasons: r.reasons,
				materials: r.materials,
				...(r.spools ? { spools: r.spools.slice(0, 10) } : {})
			});
		}
	},
	{
		name: 'get_maintenance_due',
		title: 'Maintenance due',
		description: 'Maintenance tasks (nozzle, belts, lubrication…) that are due or overdue, per printer; `all: true` lists every task with its progress.',
		inputSchema: obj({ all: { type: 'boolean', description: 'Every task, not only due and overdue ones.' } }),
		annotations: { title: 'Maintenance due', ...READ },
		control: false,
		async run(ctx, args) {
			const list = scopedPrinters(ctx);
			const names = new Map(list.map((p) => [p.id, p.name]));
			const tasks = listTasks(list.map((p) => p.id)).filter((t) => args.all === true || t.status !== 'ok');
			return ok({
				tasks: tasks.map((t) => ({ printer: names.get(t.printerId), task: t.name, status: t.status, metric: t.metric, interval: t.interval, used: round(t.used, 2), progressPercent: Math.round(t.progress * 100), lastDoneAt: t.lastDoneAt, ...(t.notes ? { notes: t.notes } : {}) })),
				overdue: tasks.filter((t) => t.status === 'overdue').length,
				due: tasks.filter((t) => t.status === 'due').length
			});
		}
	},
	{
		name: 'get_updates_available',
		title: 'OctoPrint updates',
		description: 'OctoPrint and plugin updates found by the last background check, per OctoPrint printer (admins only; nothing is installed).',
		inputSchema: obj({}),
		annotations: { title: 'OctoPrint updates', ...READ },
		control: false,
		admin: true,
		async run(ctx) {
			if (ctx.user.role !== 'admin') throw new ToolError('Only admins see OctoPrint updates');
			const out = scopedPrinters(ctx)
				.filter((p) => (p.kind ?? 'octoprint') === 'octoprint')
				.map((p) => {
					const u = cachedUpdates(p.id);
					return { printer: p.name, checkedAt: u?.checkedAt ?? null, updates: u?.available ?? [], ...(u?.error ? { error: u.error } : {}) };
				});
			return ok({ printers: out, total: out.reduce((n, p) => n + p.updates.length, 0), note: 'Install updates from the printer’s Care tab in octo·modern.' });
		}
	},
	{
		name: 'get_filament',
		title: 'Filament and spools',
		description: 'With Spoolman set up: the spool loaded on each printer’s tools (material, colour, grams left) and the spools in stock.',
		inputSchema: obj({ printer: PRINTER }),
		annotations: { title: 'Filament and spools', ...READ },
		control: false,
		async run(ctx, args) {
			if (!spoolmanConfigured()) return ok({ configured: false, note: 'Spoolman isn’t set up in octo·modern (Settings → Filament).' });
			const list = args.printer !== undefined ? [resolvePrinter(ctx, args.printer)] : scopedPrinters(ctx);
			const spool = (s: { id: number; name: string; vendor: string | null; material: string | null; color: string | null; remainingWeight: number | null; remainingLength: number | null; location: string | null }) => ({
				id: s.id,
				name: s.name,
				vendor: s.vendor,
				material: s.material,
				color: s.color,
				remainingG: round(s.remainingWeight, 0),
				remainingM: s.remainingLength == null ? null : round(s.remainingLength / 1000),
				...(s.location ? { location: s.location } : {})
			});
			const loaded = [];
			for (const p of list) {
				const ps = await printerSpools(p.id);
				loaded.push({ printer: p.name, tools: ps.tools, spools: ps.assignments.map((a) => ({ tool: a.tool, spoolId: a.spoolId, ...(a.spool ? spool(a.spool) : {}) })), ...(ps.error ? { error: ps.error } : {}) });
			}
			let stock: ReturnType<typeof spool>[] = [];
			let error: string | null = null;
			try {
				stock = (await listSpools()).map(spool);
			} catch (err) {
				error = (err as Error).message;
			}
			return ok({ configured: true, loaded, stock, ...(error ? { error } : {}) });
		}
	},

	// --- control ---------------------------------------------------------------------------------

	{
		name: 'pause_print',
		title: 'Pause print',
		description: 'Pauses the running print. Resume with resume_print.',
		inputSchema: obj({ printer: PRINTER }, ['printer']),
		annotations: { title: 'Pause print', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		control: true,
		async run(ctx, args) {
			const p = resolvePrinter(ctx, args.printer, 'control');
			const state = await currentState(p.id, backendFor(p));
			if (state === 'paused' || state === 'pausing') return ok({ done: true, printer: p.name, note: 'Already paused' });
			if (state !== 'printing') throw new ToolError(`${p.name} isn’t printing (${STATE_LABEL[state].toLowerCase()})`);
			return outcome(await jobCommand({ printer: p, backend: backendFor(p) }, ctx.locals, 'pause'), { done: true, printer: p.name, action: 'paused' });
		}
	},
	{
		name: 'resume_print',
		title: 'Resume print',
		description: 'Resumes a paused print.',
		inputSchema: obj({ printer: PRINTER }, ['printer']),
		annotations: { title: 'Resume print', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		control: true,
		async run(ctx, args) {
			const p = resolvePrinter(ctx, args.printer, 'control');
			const state = await currentState(p.id, backendFor(p));
			if (state === 'printing' || state === 'resuming') return ok({ done: true, printer: p.name, note: 'Already printing' });
			if (state !== 'paused') throw new ToolError(`${p.name} isn’t paused (${STATE_LABEL[state].toLowerCase()})`);
			return outcome(await jobCommand({ printer: p, backend: backendFor(p) }, ctx.locals, 'resume'), { done: true, printer: p.name, action: 'resumed' });
		}
	},
	{
		name: 'cancel_print',
		title: 'Cancel print',
		description: 'Cancels the running or paused print. This can’t be undone: without confirm: true it only describes what would happen. Ask the user before confirming.',
		inputSchema: obj({ printer: PRINTER, confirm: { type: 'boolean', description: 'true to really cancel. Leave out to see what would happen.' } }, ['printer']),
		annotations: { title: 'Cancel print', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		control: true,
		async run(ctx, args) {
			const p = resolvePrinter(ctx, args.printer, 'control');
			const backend = backendFor(p);
			const state = await currentState(p.id, backend);
			if (!jobActive(state)) throw new ToolError(`${p.name} has no print to cancel (${STATE_LABEL[state].toLowerCase()})`);
			const s = await snapshotOf(p);
			const item = statusItem(p, s, false);
			if (args.confirm !== true) {
				return ok({
					done: false,
					needs: 'confirm',
					message: `This would cancel ${item.file ?? 'the print'} on ${p.name}${item.progress != null ? ` at ${Math.round(item.progress)} %` : ''}. The print is lost and can’t be resumed. Call cancel_print again with confirm: true once the user agrees.`,
					printer: p.name,
					file: item.file,
					progressPercent: item.progress
				});
			}
			return outcome(await jobCommand({ printer: p, backend }, ctx.locals, 'cancel', { confirm: true }), { done: true, printer: p.name, action: 'cancelled', file: item.file });
		}
	},
	{
		name: 'start_print',
		title: 'Start print',
		description:
			'Prints a G-code file that is on the printer (see list_files with `printer`). Refused while the printer prints or isn’t ready, and until someone has confirmed the bed is clear since the last print (confirm_bed_clear). Without confirm: true it only describes what would happen. When pre-print steps (leveling, G-code) are set up, pass preprint: "run" or "skip"; when a loaded spool may run out, the answer says so.',
		inputSchema: obj(
			{
				printer: PRINTER,
				file: { type: 'string', description: 'Path of the file on the printer (or its name, when that picks out one file).' },
				origin: { type: 'string', enum: ['local', 'sdcard'], description: 'OctoPrint storage (default: local).' },
				preprint: { type: 'string', enum: ['run', 'skip'], description: 'Run the configured pre-print steps first, or skip them this time.' },
				ignore_filament_warning: { type: 'boolean', description: 'Print even though a loaded spool may run out (only after the user agreed).' },
				confirm: { type: 'boolean', description: 'true to really start. Leave out to see what would happen.' }
			},
			['printer', 'file']
		),
		annotations: { title: 'Start print', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		control: true,
		async run(ctx, args) {
			const p = resolvePrinter(ctx, args.printer, 'control');
			const backend = backendFor(p);
			const origin = args.origin === 'sdcard' ? 'sdcard' : args.origin === undefined || args.origin === 'local' ? undefined : null;
			if (origin === null) throw new ToolError('"origin" must be "local" or "sdcard"');
			const fileRef = str(args, 'file');
			if (!fileRef) throw new ToolError('"file" is required');
			const state = await currentState(p.id, backend);
			if (jobActive(state)) throw new ToolError(`${p.name} is already printing (${STATE_LABEL[state].toLowerCase()}). Wait for it to finish, or cancel it first.`);
			if (prep.isPreparing(p.id)) throw new ToolError(`${p.name} is being prepared for another print`);
			const q = getQueuePrinter(p.id);
			if (q.awaitingClear) {
				throw new ToolError(
					`The bed of ${p.name} hasn’t been confirmed clear${q.awaitingSince ? ` since the print that ended around ${q.awaitingSince}` : ''}. Ask the user to check that the bed is empty, then call confirm_bed_clear and try again.`,
					{ needs: 'bed_clear' }
				);
			}
			const f = await resolvePrinterFile(p, fileRef, origin ?? undefined);
			const fileOrigin = f.origin === 'sdcard' ? 'sdcard' : 'local';
			if (args.confirm !== true) {
				let plan = null;
				if (prepConfigured(p)) {
					try {
						plan = (await prep.plan(p, backend, fileOrigin, f.path)).steps.map(({ label, run, reason }) => ({ label, run, reason }));
					} catch {}
				}
				const s = await snapshotOf(p);
				return ok({
					done: false,
					needs: 'confirm',
					message: `This would start ${f.display || f.name} on ${p.name} (${STATE_LABEL[state].toLowerCase()}). The printer heats up and moves. Call start_print again with confirm: true once the user agrees${plan ? ', and with preprint: "run" or "skip" (pre-print steps are set up for this printer)' : ''}.`,
					printer: p.name,
					file: f.path,
					origin: fileOrigin,
					estimatedPrintSeconds: f.estimatedPrintTime,
					filamentMm: round(f.filamentMm, 0),
					temperatures: temps(s),
					...(plan ? { preprintSteps: plan } : {})
				});
			}
			const preprint = args.preprint === undefined ? undefined : args.preprint === 'run' || args.preprint === 'skip' ? args.preprint : null;
			if (preprint === null) throw new ToolError('"preprint" must be "run" or "skip"');
			const o = await printFile({ printer: p, backend }, ctx.locals, { origin: fileOrigin, path: f.path, confirm: args.ignore_filament_warning === true, preprint, via: 'mcp' });
			return outcome(o, { done: true, printer: p.name, action: 'started', file: f.path });
		}
	},
	{
		name: 'add_to_queue',
		title: 'Add to queue',
		description:
			'Adds a file to the print queue: a library file (`source` + `file`) or a file on a printer (`printer` + `file`, prints there). With a library file, `printer` picks the printer; otherwise any compatible printer (with `tags`) takes it. The queue starts it once a printer is free and its bed confirmed clear.',
		inputSchema: obj(
			{
				file: { type: 'string', description: 'Path of the file (in the library source, or on the printer).' },
				source: { type: 'string', description: 'Library source name or id (leave out for a file on the printer).' },
				printer: PRINTER,
				tags: { type: 'array', items: { type: 'string' }, description: 'For “any printer” jobs: tags a printer needs (e.g. "0.4mm", "petg").' },
				copies: { type: 'integer', minimum: 1, maximum: 99, description: 'How many copies (default 1).' }
			},
			['file']
		),
		annotations: { title: 'Add to queue', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		control: true,
		async run(ctx, args) {
			if (!mayControl(ctx)) throw new ToolError('This MCP token can’t change the queue');
			const file = str(args, 'file');
			if (!file) throw new ToolError('"file" is required');
			const printer = args.printer !== undefined ? resolvePrinter(ctx, args.printer, 'control') : null;
			if (!printer && ctx.printers !== 'all') throw new ToolError('This token is limited to some printers: pass `printer`');
			const copies = Math.round(num(args, 'copies', 1, 99, 1));
			const tags = Array.isArray(args.tags) ? args.tags : undefined;
			const srcRef = str(args, 'source');
			let b: Json;
			if (srcRef || !printer) {
				const list = sources(ctx);
				const s = srcRef ? resolveSource(ctx, srcRef) : list.length === 1 ? list[0] : null;
				if (!s) throw new ToolError(`Pass \`source\` (a library source) or \`printer\` (a file on that printer). Sources: ${list.map((x) => `“${x.name}”`).join(', ') || '(none)'}`);
				b = { source: 'library', sourceId: s.id, path: file.replace(/^\/+/, ''), printerId: printer?.id ?? null, tags, copies };
			} else {
				const f = await resolvePrinterFile(printer, file, 'local');
				b = { source: 'printer', printerId: printer.id, path: f.path, copies };
			}
			const job = await addQueueJob(ctx.locals, b);
			return ok({ done: true, job: { id: job.id, name: job.name, printer: printer?.name ?? 'any printer', ...(job.tags.length ? { tags: job.tags } : {}), copies: job.copies, status: job.status } });
		}
	},
	{
		name: 'confirm_bed_clear',
		title: 'Confirm bed is clear',
		description: 'Records that the printer’s bed is empty (the last print was removed). Only call this after a person has checked the bed: the print queue may start its next job on the printer right away, and start_print needs it.',
		inputSchema: obj({ printer: PRINTER }, ['printer']),
		annotations: { title: 'Confirm bed is clear', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		control: true,
		async run(ctx, args) {
			const p = resolvePrinter(ctx, args.printer, 'control');
			const r = await confirmBedClear(ctx.locals, p.id);
			if (!r.ok) throw new ToolError(r.message);
			return ok({ done: true, printer: p.name, note: 'Bed confirmed clear' });
		}
	},
	{
		name: 'set_temperature',
		title: 'Set temperature',
		description: 'Sets a heater’s target temperature in °C: a tool (tool0, tool1…), the bed or the chamber. 0 turns it off. Limits: tools 450, bed 200, chamber 120.',
		inputSchema: obj(
			{
				printer: PRINTER,
				heater: { type: 'string', pattern: '^(tool\\d{1,2}|bed|chamber)$', description: '"tool0" (the hotend), "tool1"…, "bed" or "chamber".' },
				target: { type: 'number', minimum: 0, maximum: 450, description: 'Target in °C (0 = off).' }
			},
			['printer', 'heater', 'target']
		),
		annotations: { title: 'Set temperature', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		control: true,
		async run(ctx, args) {
			const p = resolvePrinter(ctx, args.printer, 'control');
			const heater = str(args, 'heater') ?? '';
			const raw = args.target;
			if (typeof raw !== 'number') throw new ToolError('"target" must be a number (°C)');
			const targets = await setTemperatures({ printer: p, backend: backendFor(p) }, ctx.locals, { [heater]: raw });
			return ok({ done: true, printer: p.name, targets });
		}
	}
];

export class UnknownTool extends Error {
	constructor(name: string) {
		super(`Unknown tool: ${name}`);
		this.name = 'UnknownTool';
	}
}

/** The tools this call may see (tools/list). */
export function toolsFor(ctx: McpContext): ToolDef[] {
	return TOOLS.filter((t) => (!t.control || mayControl(ctx)) && (!t.admin || ctx.user.role === 'admin'));
}

/** Runs a tool by name for this context; unknown or unavailable tools are tool errors. */
export async function callTool(ctx: McpContext, name: string, args: Json | undefined): Promise<ToolResult> {
	const tool = TOOLS.find((t) => t.name === name);
	if (!tool) throw new UnknownTool(name);
	if (!toolsFor(ctx).includes(tool)) {
		return fail(tool.control ? (ctx.access === 'control' ? 'The token’s owner can only watch printers now' : 'This MCP token is read-only') : 'Only admins may use this tool');
	}
	try {
		return await tool.run(ctx, args ?? {});
	} catch (err) {
		return errorResult(err);
	}
}
