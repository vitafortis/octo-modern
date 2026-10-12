/**
 * Plugins & updates for OctoPrint printers (Care › Plugins & updates), through OctoPrint's
 * bundled Plugin Manager and Software Update plugins (see #lib/plugins.ts for the shapes).
 *
 * - Reads: the installed plugins, the plugin repository, the update check, and whether
 *   OctoPrint has a restart command. A 401/403 from OctoPrint means the stored key isn't an
 *   OctoPrint admin's: that becomes one clear error (code OCTOPRINT_NOT_ADMIN).
 * - Actions (one at a time per printer, admins only, never while printing — the routes check):
 *   enable/disable and uninstall answer right away; install, update and restart run in the
 *   background as an "op" with a live log, fed by the plugins' push messages (the push
 *   connection is kept open while an op runs) with polling as the fallback. After an update or
 *   a restart, OctoPrint goes away; the op waits until it answers again and records the new version.
 * - "Restart needed": pending plugin changes in OctoPrint's list, or a result that said so
 *   (kept in kv until octo·modern sees OctoPrint restart).
 * - Background: `checkAllUpdates` (a job, twice a day) caches each printer's available updates
 *   for the Care badge and notifies `octoprint.updates` once per new set of versions.
 */
import { getKv, getPrinter, listPrinters, setKv, getApiKey } from './store.ts';
import { printers } from './octoprint/manager.ts';
import { octoprintClient } from './backend/index.ts';
import { OctoPrintError, toOctoPrintError } from './octoprint/errors.ts';
import { notify } from './notify/index.ts';
import type { LiveEvent } from './octoprint/model.ts';
import type { OctoPrintClient } from './octoprint/client.ts';
import {
	availableUpdates,
	parseManagerMessage,
	parsePluginList,
	parseRepository,
	parseUpdateCheck,
	parseUpdaterMessage,
	PLUGIN_MANAGER,
	SOFTWARE_UPDATE,
	summarizeUpdates,
	updateSignature,
	type InstalledPlugin,
	type LogLine,
	type OpKind,
	type OpPhase,
	type PluginList,
	type PluginOp,
	type Repository,
	type UpdateCheck,
	type UpdateSummary
} from '#lib/plugins.ts';
import { printerTabPath } from '#lib/printer-tabs.ts';
import type { Printer } from '#lib/types.ts';

const FEATURE = 'Plugins & updates';
const MAX_LOG = 400;

/** Timings, shortened by tests. */
export const timing = {
	/** How often a running op checks on OctoPrint. */
	pollMs: 2_000,
	/** Longest an install or update may take before we give up waiting. */
	opTimeoutMs: 20 * 60_000,
	/** Longest OctoPrint may stay away after a restart. */
	restartTimeoutMs: 10 * 60_000,
	/** After a restart command, how long to wait for OctoPrint to go away before assuming it already came back. */
	restartGraceMs: 45_000,
	/** Without push messages, how long an update may report "not in progress" before we believe it. */
	updateStartGraceMs: 15_000
};

// --- errors --------------------------------------------------------------------------------

export const NOT_ADMIN = 'OCTOPRINT_NOT_ADMIN';

/** OctoPrint refused the key for an admin-only call. */
export function notAdminError(cause?: unknown): OctoPrintError {
	return new OctoPrintError('This printer’s API key isn’t an OctoPrint admin', {
		status: 403,
		code: NOT_ADMIN,
		hint: 'Plugins and updates need an admin’s key: in OctoPrint, sign in as an admin, create an Application Key (Settings → Application Keys) and paste it into this printer’s server settings in octo·modern.',
		cause
	});
}

/** Maps OctoPrint's 401/403 to the not-an-admin error; other errors pass through. */
function adminOnly(err: unknown): never {
	const e = toOctoPrintError(err);
	if (e.status === 401 || e.status === 403) {
		// OctoPrint's generic permission refusal carries no detail (httpError drops it): not an admin.
		if (/^API key rejected$/.test(e.message)) throw notAdminError(err);
		// The API key is wrong altogether (OctoPrint's "Invalid API key"): not an admin question.
		if (/invalid api key/i.test(e.message)) throw e;
		// A refusal with a reason ("Bundled plugins cannot be uninstalled", "Please reauthenticate…"): say that.
		throw new OctoPrintError(`OctoPrint refused: ${e.message.replace(/^API key rejected: /, '')}`, { status: 409, code: 'OCTOPRINT_REFUSED', cause: err });
	}
	throw e;
}

const client = (p: Printer | string): OctoPrintClient => octoprintClient(p, FEATURE);

// --- reads ------------------------------------------------------------------------------------

/** The installed plugins (falls back to the combined endpoint of OctoPrint < 1.6). */
export async function listPlugins(p: Printer | string): Promise<PluginList> {
	const c = client(p);
	try {
		const res = await c.request('GET', '/plugin/pluginmanager/plugins', { allow: [404] });
		if (res.status === 404) {
			await res.body?.cancel().catch(() => {});
			return parsePluginList(await c.get('/api/plugin/pluginmanager'));
		}
		return parsePluginList(await res.json());
	} catch (err) {
		adminOnly(err);
	}
}

/** The plugin repository as OctoPrint sees it (with its compatibility verdicts). `refresh` makes OctoPrint fetch it again. */
export async function repository(p: Printer | string, refresh = false): Promise<Repository> {
	const c = client(p);
	const q = refresh ? '?refresh=true' : '';
	try {
		const res = await c.request('GET', `/plugin/pluginmanager/repository${q}`, { allow: [404], timeoutMs: 30_000 });
		if (res.status === 404) {
			await res.body?.cancel().catch(() => {});
			return parseRepository(await c.get(`/api/plugin/pluginmanager${refresh ? '?refresh_repository=true' : ''}`, { timeoutMs: 30_000 }));
		}
		return parseRepository(await res.json());
	} catch (err) {
		adminOnly(err);
	}
}

const updatesKey = (id: string) => `plugins:updates:${id}`;
const notifiedKey = (id: string) => `plugins:notified:${id}`;
const restartKey = (id: string) => `plugins:restart:${id}`;

/** What the last update check found (for the Care badge), without asking OctoPrint. */
export function cachedUpdates(printerId: string): UpdateSummary | null {
	return getKv<UpdateSummary | null>(updatesKey(printerId), null);
}

/** How many updates the last check found (0 when never checked or it failed). */
export function updateCount(printerId: string): number {
	return cachedUpdates(printerId)?.available.length ?? 0;
}

/** Software Update's check; `force` makes OctoPrint ask upstream now instead of using its cache. Caches the summary. */
export async function checkUpdates(p: Printer | string, force = false): Promise<UpdateCheck> {
	const printer = typeof p === 'string' ? getPrinter(p) : p;
	const c = client(p);
	let raw: unknown;
	try {
		const res = await c.request('GET', `/plugin/softwareupdate/check${force ? '?force=true' : ''}`, { allow: [404], timeoutMs: force ? 90_000 : 30_000 });
		if (res.status === 404) {
			await res.body?.cancel().catch(() => {});
			throw new OctoPrintError('The Software Update plugin is disabled on this OctoPrint', { code: 'NO_SOFTWAREUPDATE', status: 400, hint: 'Enable it under Installed plugins, restart OctoPrint, then check again.' });
		}
		raw = await res.json();
	} catch (err) {
		if (err instanceof OctoPrintError && err.code === 'NO_SOFTWAREUPDATE') throw err;
		adminOnly(err);
	}
	const check = parseUpdateCheck(raw);
	if (printer) setKv(updatesKey(printer.id), summarizeUpdates(check));
	return check;
}

/** Whether OctoPrint has a restart command configured (Settings → Server → Commands). */
export async function hasRestartCommand(p: Printer | string): Promise<boolean> {
	try {
		const list = await client(p).get<unknown>('/api/system/commands/core');
		return Array.isArray(list) && list.some((c) => c && typeof c === 'object' && (c as { action?: unknown }).action === 'restart');
	} catch (err) {
		adminOnly(err);
	}
}

/** Pending plugin changes, or an action result that asked for a restart we haven't seen happen. */
export function restartNeeded(printerId: string, list: InstalledPlugin[] | null): boolean {
	return getKv<boolean>(restartKey(printerId), false) || !!list?.some((p) => p.pendingEnable || p.pendingDisable || p.pendingInstall || p.pendingUninstall);
}

function markRestart(printerId: string, needed: boolean) {
	setKv(restartKey(printerId), needed);
}

// --- ops ---------------------------------------------------------------------------------------

interface Running {
	op: PluginOp;
	release: () => void;
	timer: ReturnType<typeof setInterval> | null;
	deadline: ReturnType<typeof setTimeout> | null;
	/** Install: the plugin keys before (to spot the new one without push). */
	before: Set<string> | null;
	/** Install from the repository: the plugin id. */
	pluginId: string | null;
	/** Update/restart: OctoPrint stopped answering at some point. */
	wentAway: boolean;
	/** Update: the update targets, and whether OctoPrint reported it in progress. */
	targets: string[];
	sawProgress: boolean;
	/** Push said: restart needed / restarting / done. */
	pushed: 'restarting' | 'success' | 'error' | 'restart_manually' | 'restart_failed' | null;
	busy: boolean;
}

const KEY = Symbol.for('octo-modern.plugins');
type State = { observing: boolean; running: Map<string, Running>; last: Map<string, PluginOp>; seq: number };
type G = typeof globalThis & { [KEY]?: State };
const live: State = ((globalThis as G)[KEY] ??= { observing: false, running: new Map(), last: new Map(), seq: 0 });

/** The running op, or the last one's outcome. */
export function opState(printerId: string): PluginOp | null {
	const r = live.running.get(printerId);
	return r ? { ...r.op, log: [...r.op.log] } : (live.last.get(printerId) ?? null);
}

export const opRunning = (printerId: string) => live.running.has(printerId);

function addLog(r: Running, lines: LogLine[]) {
	if (!lines.length) return;
	r.op.log.push(...lines);
	if (r.op.log.length > MAX_LOG) r.op.log.splice(0, r.op.log.length - MAX_LOG);
}

const note = (r: Running, line: string) => addLog(r, [{ line, stream: 'message' }]);

function begin(printerId: string, kind: OpKind, label: string, by: string | null, extra: Partial<Running> = {}): Running {
	observePlugins();
	const r: Running = {
		op: { id: ++live.seq, kind, label, phase: 'running', startedAt: new Date().toISOString(), startedBy: by, endedAt: null, log: [], message: null, needsRestart: false, newVersion: null },
		release: printers.watch(printerId),
		timer: null,
		deadline: null,
		before: null,
		pluginId: null,
		wentAway: false,
		targets: [],
		sawProgress: false,
		pushed: null,
		busy: false,
		...extra
	};
	live.running.set(printerId, r);
	return r;
}

function finish(printerId: string, r: Running, phase: Extract<OpPhase, 'done' | 'error'>, message: string | null, extra: Partial<PluginOp> = {}) {
	if (live.running.get(printerId) !== r) return;
	live.running.delete(printerId);
	if (r.timer) clearInterval(r.timer);
	if (r.deadline) clearTimeout(r.deadline);
	r.release();
	Object.assign(r.op, { phase, message, endedAt: new Date().toISOString() }, extra);
	if (r.op.needsRestart) markRestart(printerId, true);
	live.last.set(printerId, r.op);
}

/** Refuses a second action while one runs. */
function ensureFree(printerId: string) {
	if (live.running.has(printerId)) {
		const r = live.running.get(printerId)!;
		throw new OctoPrintError(`Wait for the running ${r.op.kind} (${r.op.label}) to finish`, { status: 409, code: 'OP_RUNNING' });
	}
}

function every(printerId: string, r: Running, fn: () => Promise<void>, timeoutMs: number, onTimeout: string) {
	r.timer = setInterval(async () => {
		if (r.busy || live.running.get(printerId) !== r) return;
		r.busy = true;
		try {
			await fn();
		} catch (err) {
			console.warn(`[octo-modern] plugins: checking on ${printerId} failed: ${(err as Error).message}`);
		} finally {
			r.busy = false;
		}
	}, timing.pollMs);
	r.timer.unref?.();
	r.deadline = setTimeout(() => finish(printerId, r, 'error', onTimeout), timeoutMs);
	r.deadline.unref?.();
}

/** Starts listening to every printer's Plugin Manager and Software Update messages (once per process). */
export function observePlugins() {
	if (live.observing) return;
	live.observing = true;
	printers.observe(onLiveEvent);
}

/** Handles one live event; exported for tests. */
export function onLiveEvent(printerId: string, e: LiveEvent) {
	if (e.type !== 'plugin') return;
	const r = live.running.get(printerId);
	if (!r) return;
	if (e.plugin === PLUGIN_MANAGER) {
		const m = parseManagerMessage(e.data);
		if (!m) return;
		if (m.kind === 'log') return addLog(r, m.lines);
		if (m.kind !== 'result') return;
		if (m.needsRestart) r.op.needsRestart = true;
		if (r.op.kind === 'install' && m.action === 'install' && !m.partial) {
			if (m.ok) finish(printerId, r, 'done', m.plugin ? `${m.plugin.name}${m.plugin.version ? ` ${m.plugin.version}` : ''} installed` : 'Installed', { needsRestart: m.needsRestart || r.op.needsRestart });
			else finish(printerId, r, 'error', m.reason ?? 'The install failed; the log has the details');
		}
	} else if (e.plugin === SOFTWARE_UPDATE && r.op.kind === 'update') {
		const m = parseUpdaterMessage(e.data);
		if (!m) return;
		if (m.kind === 'log') return addLog(r, m.lines);
		if (m.kind === 'updating') {
			r.sawProgress = true;
			return note(r, `Updating ${m.name ?? m.target}${m.version ? ` to ${m.version}` : ''}…`);
		}
		if (m.kind === 'target_failed') return note(r, `${m.name ?? m.target} failed${m.reason ? `: ${m.reason}` : ''}`);
		if (m.kind === 'restarting') {
			r.pushed = 'restarting';
			r.op.phase = 'restarting';
			return note(r, 'Restarting OctoPrint…');
		}
		if (m.kind === 'success' || m.kind === 'error' || m.kind === 'restart_manually' || m.kind === 'restart_failed') r.pushed = m.kind;
	}
}

// --- actions -----------------------------------------------------------------------------------

/** Enable or disable a plugin. Resolves with OctoPrint's result; marks a needed restart. */
export async function togglePlugin(p: Printer, key: string, command: 'enable' | 'disable'): Promise<{ needsRestart: boolean; plugin: InstalledPlugin | null }> {
	ensureFree(p.id);
	let res: Record<string, unknown>;
	try {
		res = (await client(p).post<Record<string, unknown>>('/api/plugin/pluginmanager', { command, plugin: key }, { timeoutMs: 60_000 })) ?? {};
	} catch (err) {
		adminOnly(err);
	}
	if (res.result === false) throw new OctoPrintError(`OctoPrint couldn’t ${command} the plugin${typeof res.reason === 'string' ? `: ${res.reason}` : ''}`, { status: 409, code: 'PLUGIN_ACTION_FAILED' });
	const needsRestart = res.needs_restart === true;
	if (needsRestart) markRestart(p.id, true);
	const plugin = res.plugin ? parsePluginList({ plugins: [res.plugin] }).plugins[0] ?? null : null;
	return { needsRestart, plugin };
}

/** Uninstalls a plugin (pip or the plugin folder), optionally deleting its settings and data. */
export async function uninstallPlugin(p: Printer, plugin: InstalledPlugin, cleanup: boolean, by: string | null): Promise<PluginOp> {
	ensureFree(p.id);
	const r = begin(p.id, 'uninstall', plugin.name, by);
	note(r, `Uninstalling ${plugin.name}${cleanup ? ' and deleting its settings and data' : ''}…`);
	try {
		const res = (await client(p).post<Record<string, unknown>>('/api/plugin/pluginmanager', { command: 'uninstall', plugin: plugin.key, cleanup }, { timeoutMs: 180_000 })) ?? {};
		if (res.result === false) {
			finish(p.id, r, 'error', typeof res.reason === 'string' ? res.reason : 'OctoPrint couldn’t uninstall it');
		} else {
			note(r, `${plugin.name} uninstalled`);
			finish(p.id, r, 'done', `${plugin.name} uninstalled`, { needsRestart: res.needs_restart === true || cleanup });
		}
	} catch (err) {
		finish(p.id, r, 'error', toOctoPrintError(err).message);
		adminOnly(err);
	}
	return opState(p.id)!;
}

/**
 * Installs a plugin from an archive URL (a repository entry's archive, or one pasted). Resolves
 * once OctoPrint has started; the op finishes on its result message (or, without push, when the
 * new plugin shows up in the list).
 */
export async function installPlugin(p: Printer, opts: { url: string; label: string; pluginId?: string | null; fromRepo: boolean }, by: string | null): Promise<PluginOp> {
	ensureFree(p.id);
	let before: Set<string> | null = null;
	try {
		before = new Set((await listPlugins(p)).plugins.map((x) => x.key));
	} catch (err) {
		if (err instanceof OctoPrintError && err.code === NOT_ADMIN) throw err;
	}
	const r = begin(p.id, 'install', opts.label, by, { before, pluginId: opts.pluginId ?? null });
	note(r, `Installing ${opts.label} from ${opts.url}`);
	try {
		await client(p).post('/api/plugin/pluginmanager', { command: 'install', url: opts.url, ...(opts.fromRepo ? { from_repo: true } : {}) }, { timeoutMs: 60_000 });
	} catch (err) {
		finish(p.id, r, 'error', toOctoPrintError(err).message);
		adminOnly(err);
	}
	every(
		p.id,
		r,
		async () => {
			// Push delivers the result; without it, watch for the new plugin in the list.
			if (printers.pushState(p.id) === 'open' || !r.before) return;
			const now = await listPlugins(p);
			const added = now.plugins.find((x) => !r.before!.has(x.key) || (r.pluginId && x.key === r.pluginId && x.pendingInstall));
			if (added) finish(p.id, r, 'done', `${added.name}${added.version ? ` ${added.version}` : ''} installed`, { needsRestart: added.pendingInstall || r.op.needsRestart });
		},
		timing.opTimeoutMs,
		'No result from OctoPrint’s Plugin Manager in time; check its log (Settings → Logging → plugin_pluginmanager_console.log)'
	);
	return opState(p.id)!;
}

/** Waits for OctoPrint to go away and answer again; returns its version when back, null while away. */
async function probeVersion(p: Printer): Promise<string | null> {
	try {
		const v = await client(p).request('GET', '/api/version', { timeoutMs: 4_000 });
		if (!v.ok) return null;
		const body = (await v.json()) as { server?: unknown };
		return typeof body?.server === 'string' ? body.server : '?';
	} catch {
		return null;
	}
}

async function cameBack(p: Printer, r: Running, version: string) {
	r.op.newVersion = version;
	note(r, `OctoPrint is back (${version})`);
	markRestart(p.id, false);
	r.op.needsRestart = false;
	void printers.poll(p.id);
	try {
		await checkUpdates(p, false);
	} catch {
		// The cached summary stays; the next check fixes it.
	}
}

/** Updates OctoPrint and/or plugins through Software Update (it restarts OctoPrint when its restart command is set). */
export async function startUpdate(p: Printer, targets: string[], label: string, by: string | null): Promise<PluginOp> {
	ensureFree(p.id);
	const r = begin(p.id, 'update', label, by, { targets });
	note(r, `Updating ${label}…`);
	let order: string[] = [];
	try {
		const res = await client(p).post<{ order?: unknown; queued?: unknown }>('/plugin/softwareupdate/update', { targets }, { timeoutMs: 60_000 });
		if (res && res.queued !== undefined) {
			finish(p.id, r, 'error', 'OctoPrint queued the update until the current print ends');
			return opState(p.id)!;
		}
		order = Array.isArray(res?.order) ? res.order.filter((x): x is string => typeof x === 'string') : [];
	} catch (err) {
		finish(p.id, r, 'error', toOctoPrintError(err).message);
		adminOnly(err);
	}
	if (!order.length) {
		finish(p.id, r, 'error', 'OctoPrint found nothing to update (check again: the update may be gone already)');
		return opState(p.id)!;
	}
	const started = Date.now();
	every(
		p.id,
		r,
		async () => {
			const version = await probeVersion(p);
			if (version === null) {
				if (!r.wentAway) note(r, 'OctoPrint is restarting; waiting for it to come back…');
				r.wentAway = true;
				r.op.phase = 'restarting';
				return;
			}
			if (r.wentAway) {
				await cameBack(p, r, version);
				const still = availableUpdates(await checkUpdates(p, false).catch(() => null)).filter((t) => r.targets.includes(t.key));
				if (still.length) finish(p.id, r, 'error', `OctoPrint is back, but ${still.map((t) => t.name).join(', ')} still ${still.length === 1 ? 'has an update' : 'have updates'}: see the log`);
				else finish(p.id, r, 'done', `Updated; OctoPrint ${version} is running`);
				return;
			}
			if (r.pushed === 'restarting') return;
			if (r.pushed === 'error') return finish(p.id, r, 'error', 'The update failed; the log has the details');
			if (r.pushed === 'success') return finish(p.id, r, 'done', 'Updated');
			if (r.pushed === 'restart_manually' || r.pushed === 'restart_failed') {
				return finish(p.id, r, 'done', r.pushed === 'restart_failed' ? 'Updated, but OctoPrint couldn’t restart itself: restart it' : 'Updated: restart OctoPrint to finish', { needsRestart: true });
			}
			// No push: ask Software Update whether it's still busy.
			if (printers.pushState(p.id) === 'open') return;
			const check = await checkUpdates(p, false);
			if (check.status === 'inProgress') {
				r.sawProgress = true;
				return;
			}
			if (!r.sawProgress && Date.now() - started < timing.updateStartGraceMs) return;
			const still = availableUpdates(check).filter((t) => r.targets.includes(t.key));
			if (still.length) finish(p.id, r, 'error', `${still.map((t) => t.name).join(', ')} still ${still.length === 1 ? 'has an update' : 'have updates'}; see OctoPrint’s Software Update log`);
			else finish(p.id, r, 'done', 'Updated: restart OctoPrint if it didn’t restart itself', { needsRestart: true });
		},
		timing.opTimeoutMs,
		'The update didn’t finish in time; check OctoPrint (Settings → Software Update → log)'
	);
	return opState(p.id)!;
}

/** Restarts OctoPrint with its configured restart command, then waits until it answers again. */
export async function restartOctoPrint(p: Printer, by: string | null): Promise<PluginOp> {
	ensureFree(p.id);
	if (!(await hasRestartCommand(p))) {
		throw new OctoPrintError('OctoPrint has no restart command configured', {
			status: 409,
			code: 'NO_RESTART_COMMAND',
			hint: 'Set one in OctoPrint → Settings → Server → Commands → “Restart OctoPrint” (OctoPi: sudo service octoprint restart), or restart it on its host.'
		});
	}
	const r = begin(p.id, 'restart', 'OctoPrint', by);
	r.op.phase = 'restarting';
	note(r, 'Restarting OctoPrint…');
	try {
		await client(p).post('/api/system/commands/core/restart', {}, { timeoutMs: 15_000 });
	} catch (err) {
		const e = toOctoPrintError(err);
		// The connection may drop as it goes down: that's the restart working.
		if (e.status !== undefined) {
			finish(p.id, r, 'error', e.message);
			adminOnly(err);
		}
		r.wentAway = true;
	}
	const started = Date.now();
	every(
		p.id,
		r,
		async () => {
			const version = await probeVersion(p);
			if (version === null) {
				if (!r.wentAway) note(r, 'OctoPrint stopped; waiting for it to come back…');
				r.wentAway = true;
				return;
			}
			if (r.wentAway || Date.now() - started > timing.restartGraceMs) {
				await cameBack(p, r, version);
				finish(p.id, r, 'done', r.wentAway ? `OctoPrint ${version} restarted` : `OctoPrint ${version} answers again (it restarted quickly, or the command didn’t restart it)`);
			}
		},
		timing.restartTimeoutMs,
		'OctoPrint didn’t come back in time; check its host'
	);
	return opState(p.id)!;
}

// --- background: update checks and the notification ------------------------------------------------

/** Notifies `octoprint.updates` for a printer when its set of new versions changed since the last one. Returns whether it did. */
export async function maybeNotifyUpdates(printerId: string, check: UpdateCheck): Promise<boolean> {
	const list = availableUpdates(check);
	const sig = updateSignature(list);
	const prev = getKv<string>(notifiedKey(printerId), '');
	if (sig === prev) return false;
	setKv(notifiedKey(printerId), sig);
	if (!sig) return false;
	const printer = getPrinter(printerId);
	const name = printer?.name ?? 'A printer';
	const op = list.find((t) => t.key === 'octoprint');
	const others = list.filter((t) => t.key !== 'octoprint');
	const parts = [op ? `OctoPrint ${op.current ?? '?'} → ${op.available ?? '?'}` : null, others.length ? `${others.length} plugin update${others.length === 1 ? '' : 's'}` : null].filter(Boolean);
	await notify({
		kind: 'octoprint.updates',
		printerId,
		printerName: printer?.name ?? null,
		title: `Updates available: ${name}`,
		message: `${name}: ${parts.join(' and ')} available.`,
		fields: list.slice(0, 10).map((t) => ({ label: t.name, value: `${t.current ?? '?'} → ${t.available ?? '?'}` })),
		data: { updates: list.map((t) => ({ key: t.key, name: t.name, current: t.current, available: t.available, releaseNotes: t.releaseNotes })) },
		link: printerTabPath(printerId, 'care', 'plugins'),
		dedupeKey: `updates:${sig}`,
		snapshot: false
	});
	return true;
}

/** The job: checks every OctoPrint printer (OctoPrint's cached answer), caches it and notifies new versions. */
export async function checkAllUpdates(): Promise<void> {
	for (const p of listPrinters()) {
		if (p.kind !== 'octoprint' || !getApiKey(p.id) || live.running.has(p.id)) continue;
		try {
			const check = await checkUpdates(p, false);
			await maybeNotifyUpdates(p.id, check);
		} catch (err) {
			const prev = cachedUpdates(p.id);
			setKv(updatesKey(p.id), { checkedAt: new Date().toISOString(), available: prev?.available ?? [], error: toOctoPrintError(err).message } satisfies UpdateSummary);
		}
	}
}
