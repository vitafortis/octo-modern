/**
 * Bed meshes per printer, from the Bed Visualizer plugin (see #lib/bedmesh.ts for what the
 * plugin offers):
 *
 * - detection: GET /api/settings has `plugins.bedlevelvisualizer` when it's installed; the
 *   answer is cached in kv so the printer page knows without asking OctoPrint every time.
 * - storage: every distinct mesh becomes a row in `bed_meshes` (when it was first seen, and
 *   last seen), from the plugin's stored mesh (a background sync) or its push messages.
 * - "Update mesh": sends `@BEDLEVELVISUALIZER` + the plugin's probe G-code, keeps the push
 *   connection open, and waits for the plugin's `{ mesh, bed }` message (or, without push,
 *   for its stored mesh to change), then stores it and writes it back to the plugin's
 *   settings the way its own UI does.
 * - drift: each new mesh is checked against the flatness / change limits and the reference
 *   mesh; a breach sends a `bed.drift` notification.
 */
import { createHash } from 'node:crypto';
import { getKv, getPrinter, listPrinters, setKv, sqlite } from './store.ts';
import { clientFor, printers } from './octoprint/manager.ts';
import { toOctoPrintError } from './octoprint/errors.ts';
import { notify } from './notify/index.ts';
import type { LiveEvent } from './octoprint/model.ts';
import {
	BLV_PLUGIN,
	checkDrift,
	DEFAULT_DRIFT,
	evenAxis,
	meshKey,
	meshStats,
	parsePluginMessage,
	parsePluginSettings,
	round,
	type DriftSettings,
	type Mesh,
	type MeshSnapshot,
	type MeshSource,
	type MeshSummary,
	type PluginInfo,
	type UpdatePhase,
	type UpdateState,
	updateCommands
} from '#lib/bedmesh.ts';

type Row = Record<string, unknown>;
const db = () => sqlite();

/** Meshes kept per printer (the reference is never pruned). */
export const KEEP_PER_PRINTER = 250;

// --- plugin detection ----------------------------------------------------------------

const pluginKey = (id: string) => `bedmesh:plugin:${id}`;

/** What we last learned about the plugin on this printer (without asking OctoPrint); null if never checked. */
export function cachedPlugin(printerId: string): Omit<PluginInfo, 'stored'> | null {
	return getKv<Omit<PluginInfo, 'stored'> | null>(pluginKey(printerId), null);
}

/**
 * Asks OctoPrint (GET /api/settings): is the plugin installed, how is it set up, and the mesh
 * it stores (which is ingested). On failure, the last known answer with `error` set.
 */
export async function detectPlugin(printerId: string): Promise<PluginInfo> {
	try {
		const settings = await clientFor(printerId).settings();
		const info = parsePluginSettings(settings?.plugins);
		const { stored, ...rest } = info;
		setKv(pluginKey(printerId), { ...rest, error: null });
		if (stored) ingest(printerId, stored, 'octoprint', { pluginTimestamp: info.storedTimestamp });
		return { ...info, error: null };
	} catch (err) {
		const prev = cachedPlugin(printerId);
		const error = toOctoPrintError(err).message;
		return { ...(prev ?? { installed: false, commands: [], saveMesh: false, timeoutS: 0, storedTimestamp: null, checkedAt: new Date().toISOString() }), stored: null, error };
	}
}

/** Known installed (from the cache; checks OctoPrint, up to `waitMs`, when it was never checked). */
export async function pluginInstalled(printerId: string, waitMs = 2_000): Promise<boolean> {
	const cached = cachedPlugin(printerId);
	if (cached) return cached.installed;
	const probe = detectPlugin(printerId).then((i) => i.installed);
	return Promise.race([probe, new Promise<boolean>((r) => setTimeout(() => r(false), waitMs).unref?.())]);
}

// --- storage ---------------------------------------------------------------------------

function toSummary(r: Row): MeshSummary {
	return {
		id: Number(r.id),
		printerId: r.printer_id as string,
		createdAt: r.created_at as string,
		lastSeenAt: r.last_seen_at as string,
		pluginTimestamp: (r.plugin_timestamp as string) ?? null,
		source: r.source as MeshSource,
		rows: Number(r.rows),
		cols: Number(r.cols),
		min: Number(r.min),
		max: Number(r.max),
		mean: Number(r.mean),
		flatness: Number(r.flatness),
		change: r.change == null ? null : Number(r.change),
		drift: r.drift === 1
	};
}

function toSnapshot(r: Row): MeshSnapshot {
	const mesh = JSON.parse(r.mesh as string) as Mesh;
	return { ...toSummary(r), mesh, stats: meshStats(mesh)! };
}

const SUMMARY_COLS = 'id, printer_id, created_at, last_seen_at, plugin_timestamp, source, rows, cols, min, max, mean, flatness, change, drift';

/** The printer's meshes, newest first, without grids. */
export function listMeshes(printerId: string, limit = KEEP_PER_PRINTER): MeshSummary[] {
	return (db().prepare(`SELECT ${SUMMARY_COLS} FROM bed_meshes WHERE printer_id = ? ORDER BY id DESC LIMIT ?`).all(printerId, limit) as Row[]).map(toSummary);
}

export function getMesh(id: number): MeshSnapshot | undefined {
	const r = db().prepare('SELECT * FROM bed_meshes WHERE id = ?').get(id) as Row | undefined;
	return r && toSnapshot(r);
}

export function latestMesh(printerId: string): MeshSnapshot | undefined {
	const r = db().prepare('SELECT * FROM bed_meshes WHERE printer_id = ? ORDER BY id DESC LIMIT 1').get(printerId) as Row | undefined;
	return r && toSnapshot(r);
}

export function deleteMesh(id: number): boolean {
	return Number(db().prepare('DELETE FROM bed_meshes WHERE id = ?').run(id).changes) > 0;
}

// --- drift settings ------------------------------------------------------------------------

const driftKey = (id: string) => `bedmesh:drift:${id}`;

export function driftSettings(printerId: string): DriftSettings {
	return { ...DEFAULT_DRIFT, ...getKv<Partial<DriftSettings>>(driftKey(printerId), {}) };
}

export function saveDriftSettings(printerId: string, s: DriftSettings) {
	setKv(driftKey(printerId), s);
}

/** The reference mesh: the chosen one, or the oldest kept. */
export function referenceMesh(printerId: string, s = driftSettings(printerId)): MeshSnapshot | undefined {
	if (s.referenceId != null) {
		const m = getMesh(s.referenceId);
		if (m && m.printerId === printerId) return m;
	}
	const r = db().prepare('SELECT * FROM bed_meshes WHERE printer_id = ? ORDER BY id ASC LIMIT 1').get(printerId) as Row | undefined;
	return r && toSnapshot(r);
}

// --- ingest --------------------------------------------------------------------------------

const hashOf = (mesh: Mesh) => createHash('sha256').update(meshKey(mesh)).digest('hex').slice(0, 32);

export interface IngestResult {
	snapshot: MeshSnapshot;
	/** A mesh we hadn't seen (false: the latest one, seen again). */
	isNew: boolean;
}

/**
 * Stores a mesh when it differs from the printer's latest one (else marks the latest as seen
 * again). A new mesh is checked for drift, and notified when it breaks a limit.
 */
export function ingest(printerId: string, mesh: Mesh, source: MeshSource, opts: { pluginTimestamp?: string | null; now?: Date; notify?: boolean } = {}): IngestResult | null {
	const stats = meshStats(mesh);
	if (!stats || !getPrinter(printerId)) return null;
	const now = (opts.now ?? new Date()).toISOString();
	const hash = hashOf(mesh);
	// The plugin's stored mesh can trail ours (when writing it back failed): one we already
	// have is only marked as seen. Live meshes compare with the latest only.
	const latest = (
		source === 'octoprint'
			? db().prepare('SELECT id, hash FROM bed_meshes WHERE printer_id = ? AND hash = ? ORDER BY id DESC LIMIT 1').get(printerId, hash)
			: db().prepare('SELECT id, hash FROM bed_meshes WHERE printer_id = ? ORDER BY id DESC LIMIT 1').get(printerId)
	) as Row | undefined;
	if (latest && latest.hash === hash) {
		db().prepare('UPDATE bed_meshes SET last_seen_at = ?, plugin_timestamp = coalesce(?, plugin_timestamp) WHERE id = ?').run(now, opts.pluginTimestamp ?? null, latest.id as number);
		return { snapshot: getMesh(Number(latest.id))!, isNew: false };
	}
	const settings = driftSettings(printerId);
	const ref = referenceMesh(printerId, settings);
	const check = checkDrift(mesh, ref?.mesh ?? null, settings);
	const breached = !!check && check.breaches.length > 0;
	const stored: Mesh = { z: mesh.z.map((r) => r.map((v) => (v === null ? null : round(v, 5)))), xs: mesh.xs, ys: mesh.ys.length === mesh.z.length ? mesh.ys : evenAxis(mesh.z.length) };
	const r = db()
		.prepare(
			`INSERT INTO bed_meshes (printer_id, created_at, last_seen_at, plugin_timestamp, source, hash, rows, cols, mesh, min, max, mean, flatness, change, drift)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(printerId, now, now, opts.pluginTimestamp ?? null, source, hash, stats.rows, stats.cols, JSON.stringify(stored), stats.min, stats.max, stats.mean, stats.flatness, check?.change ?? null, breached ? 1 : 0);
	const id = Number(r.lastInsertRowid);
	prune(printerId, settings.referenceId);
	const snapshot = getMesh(id)!;
	// The very first mesh is the reference: nothing to drift from, but flatness still counts.
	if (breached && settings.enabled && opts.notify !== false) void notifyDrift(printerId, snapshot, check!.breaches);
	return { snapshot, isNew: true };
}

function prune(printerId: string, keepId: number | null) {
	const ids = (db().prepare('SELECT id FROM bed_meshes WHERE printer_id = ? ORDER BY id DESC').all(printerId) as Row[]).map((r) => Number(r.id));
	if (ids.length <= KEEP_PER_PRINTER) return;
	// Keep the oldest too (the default reference) and the chosen reference.
	const kept = new Set([ids[ids.length - 1], ...(keepId != null && ids.includes(keepId) ? [keepId] : [])]);
	const rest = ids.filter((id) => !kept.has(id));
	for (const id of rest.slice(KEEP_PER_PRINTER - kept.size)) db().prepare('DELETE FROM bed_meshes WHERE id = ?').run(id);
}

async function notifyDrift(printerId: string, s: MeshSnapshot, breaches: string[]) {
	const printer = getPrinter(printerId);
	await notify({
		kind: 'bed.drift',
		printerId,
		printerName: printer?.name ?? null,
		title: `Bed mesh drift: ${printer?.name ?? 'printer'}`,
		message: `${printer?.name ?? 'A printer'}: ${breaches.join('; ')}.`,
		fields: [
			{ label: 'Flatness', value: `${s.flatness.toFixed(3)} mm` },
			{ label: 'Range', value: `${s.min.toFixed(3)} … ${s.max.toFixed(3)} mm` },
			...(s.change != null ? [{ label: 'Change from reference', value: `${s.change.toFixed(3)} mm` }] : []),
			{ label: 'Grid', value: `${s.cols} × ${s.rows}` }
		],
		data: { meshId: s.id, flatness: s.flatness, change: s.change, min: s.min, max: s.max },
		link: `/p/${encodeURIComponent(printerId)}?tab=bed`,
		dedupeKey: `mesh:${s.id}`,
		snapshot: false
	});
}

// --- live: the plugin's push messages --------------------------------------------------------

interface Running {
	state: UpdateState;
	release: () => void;
	timer: ReturnType<typeof setTimeout> | null;
	poller: ReturnType<typeof setInterval> | null;
	baseline: string | null;
	zMax: number | null;
}

const KEY = Symbol.for('octo-modern.bedmesh');
type G = typeof globalThis & { [KEY]?: { observing: boolean; running: Map<string, Running>; last: Map<string, UpdateState> } };
const live = ((globalThis as G)[KEY] ??= { observing: false, running: new Map(), last: new Map() });

/** Starts listening to every printer's plugin messages (once per process). */
export function observePlugin() {
	if (live.observing) return;
	live.observing = true;
	printers.observe(onLiveEvent);
}

/** Handles one live event; exported for tests. */
export function onLiveEvent(printerId: string, e: LiveEvent) {
	if (e.type !== 'plugin' || e.plugin !== BLV_PLUGIN) return;
	const msg = parsePluginMessage(e.data);
	if (!msg) return;
	const run = live.running.get(printerId);
	if (msg.kind === 'processing') {
		if (run && run.state.phase === 'sending') run.state = { ...run.state, phase: 'probing' };
	} else if (msg.kind === 'error') {
		if (run) finish(printerId, run, 'error', msg.message);
	} else if (msg.kind === 'mesh') {
		if (run) run.zMax = msg.zMax;
		const res = ingest(printerId, msg.mesh, run ? 'update' : 'push');
		if (run && res) finish(printerId, run, 'done', null, res.snapshot.id);
		if (res) void saveToPlugin(printerId, res.snapshot, msg.zMax);
	}
}

/**
 * Writes the mesh into the plugin's settings, as its own web UI does after a probe run, so
 * OctoPrint's Bed Visualizer tab shows it too. Only when the plugin's "save mesh" is on. Best effort.
 */
async function saveToPlugin(printerId: string, s: MeshSnapshot, zMax: number | null) {
	const info = cachedPlugin(printerId);
	if (!info?.installed || !info.saveMesh) return;
	try {
		await clientFor(printerId).post('/api/settings', {
			plugins: {
				[BLV_PLUGIN]: {
					stored_mesh: s.mesh.z.map((r) => r.map((v) => (v === null ? null : String(v)))),
					stored_mesh_x: s.mesh.xs,
					stored_mesh_y: s.mesh.ys,
					...(zMax != null ? { stored_mesh_z_height: zMax } : {}),
					mesh_timestamp: new Date(s.createdAt).toLocaleString('en-GB')
				}
			}
		});
	} catch (err) {
		console.warn(`[octo-modern] could not save the bed mesh to OctoPrint for ${printerId}: ${(err as Error).message}`);
	}
}

function finish(printerId: string, run: Running, phase: UpdatePhase, message: string | null, meshId: number | null = null) {
	if (live.running.get(printerId) !== run) return;
	live.running.delete(printerId);
	if (run.timer) clearTimeout(run.timer);
	if (run.poller) clearInterval(run.poller);
	run.release();
	const state: UpdateState = { ...run.state, phase, message, meshId, endedAt: new Date().toISOString() };
	live.last.set(printerId, state);
}

/** The running update, or the last one's outcome. */
export function updateState(printerId: string): UpdateState | null {
	return live.running.get(printerId)?.state ?? live.last.get(printerId) ?? null;
}

export function updateRunning(printerId: string): boolean {
	return live.running.has(printerId);
}

/** How often, while an update runs, the plugin's stored mesh is checked (for servers without push). */
const FALLBACK_POLL_MS = 4_000;
/** Longest we wait for a probe run (the plugin's own timeout, capped). */
const MAX_WAIT_MS = 30 * 60_000;

/**
 * Starts a probe run: sends the plugin's at-command and G-code, then waits for the mesh.
 * The caller has checked permissions and printer state. Resolves once the G-code is sent.
 */
export async function startUpdate(printerId: string, info: PluginInfo, by: string | null, opts: { pollMs?: number } = {}): Promise<UpdateState> {
	observePlugin();
	const run: Running = {
		state: { phase: 'sending', startedAt: new Date().toISOString(), startedBy: by, endedAt: null, message: null, meshId: null },
		release: printers.watch(printerId),
		timer: null,
		poller: null,
		baseline: latestMesh(printerId) ? hashOf(latestMesh(printerId)!.mesh) : null,
		zMax: null
	};
	live.running.set(printerId, run);
	try {
		await clientFor(printerId).sendCommands(updateCommands(info.commands));
	} catch (err) {
		finish(printerId, run, 'error', toOctoPrintError(err).message);
		throw err;
	}
	if (live.running.get(printerId) === run && run.state.phase === 'sending') run.state = { ...run.state, phase: 'probing' };
	const waitMs = Math.min(MAX_WAIT_MS, Math.max(60_000, info.timeoutS * 1000));
	run.timer = setTimeout(() => finish(printerId, run, 'timeout', `No mesh arrived within ${Math.round(waitMs / 60_000)} min`), waitMs);
	run.timer.unref?.();
	// Without a push connection the plugin's message never reaches us; its stored mesh
	// changes when OctoPrint's own UI (open somewhere) saves it.
	run.poller = setInterval(async () => {
		if (live.running.get(printerId) !== run || printers.pushState(printerId) === 'open') return;
		try {
			const p = parsePluginSettings((await clientFor(printerId).settings())?.plugins);
			if (p.stored && hashOf(p.stored) !== run.baseline && live.running.get(printerId) === run) {
				const res = ingest(printerId, p.stored, 'update', { pluginTimestamp: p.storedTimestamp });
				if (res) finish(printerId, run, 'done', null, res.snapshot.id);
			}
		} catch {
			// Keep waiting; the timeout ends it.
		}
	}, opts.pollMs ?? FALLBACK_POLL_MS);
	run.poller.unref?.();
	return run.state;
}

/** Background sync: checks the plugin (and ingests its stored mesh) on every printer. */
export async function syncAll(): Promise<void> {
	observePlugin();
	for (const p of listPrinters()) {
		if (live.running.has(p.id)) continue;
		await detectPlugin(p.id);
	}
}
