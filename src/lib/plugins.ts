/**
 * OctoPrint's plugins and software updates, as plain data: what the bundled Plugin Manager
 * (`/plugin/pluginmanager/*`, `/api/plugin/pluginmanager`) and Software Update
 * (`/plugin/softwareupdate/*`) plugins answer and push, parsed defensively, plus the rules
 * the UI and the server share (what can be toggled or uninstalled, whether OctoPrint needs a
 * restart, which updates are new). Pure: no I/O, safe in the browser and in tests.
 *
 * Shapes checked against OctoPrint 1.11 (pluginmanager/__init__.py `_to_external_plugin`,
 * `_plugin_response`, `map_repository_entry`, `_send_result_notification`, `_log`;
 * softwareupdate/__init__.py `check_for_update`, `perform_update`, `_send_client_message`).
 * Older releases (1.4–1.5) only have the combined `GET /api/plugin/pluginmanager`, which
 * carries the same `plugins` and `repository` keys.
 */

export const PLUGIN_MANAGER = 'pluginmanager';
export const SOFTWARE_UPDATE = 'softwareupdate';

export interface PluginNotice {
	text: string;
	link: string | null;
	important: boolean;
}

export interface InstalledPlugin {
	key: string;
	name: string;
	description: string;
	author: string | null;
	version: string | null;
	url: string | null;
	license: string | null;
	/** Ships with OctoPrint (can't be uninstalled). */
	bundled: boolean;
	/** OctoPrint lets it be uninstalled (a bundled plugin may still be togglable). */
	managable: boolean;
	enabled: boolean;
	blacklisted: boolean;
	forcedDisabled: boolean;
	incompatible: boolean;
	/** Disabled because OctoPrint runs in safe mode. */
	safeModeVictim: boolean;
	pendingEnable: boolean;
	pendingDisable: boolean;
	pendingInstall: boolean;
	pendingUninstall: boolean;
	/** OctoPrint's warning for disabling it (a sentence), or null. */
	disablingDiscouraged: string | null;
	/** entry_point | folder | module … */
	origin: string | null;
	notices: PluginNotice[];
}

export interface PluginList {
	plugins: InstalledPlugin[];
	/** OctoPrint's version string, when the answer has it. */
	octoprint: string | null;
	safeMode: boolean;
	/** OctoPrint's own connectivity check (repository and updates need the internet). */
	online: boolean | null;
	/** pip is usable: installs work. */
	pipAvailable: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const bool = (v: unknown) => v === true;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function parsePlugin(raw: unknown): InstalledPlugin | null {
	const p = obj(raw);
	const key = str(p.key);
	if (!key) return null;
	const notices = Array.isArray(p.notifications)
		? p.notifications.map((n) => obj(n)).filter((n) => str(n.text)).map((n) => ({ text: String(n.text).replace(/<[^>]+>/g, '').trim(), link: safeUrl(n.link), important: bool(n.important) }))
		: [];
	return {
		key,
		name: str(p.name) ?? key,
		description: str(p.description) ?? '',
		author: str(p.author),
		version: str(p.version),
		url: safeUrl(p.url),
		license: str(p.license),
		bundled: bool(p.bundled),
		managable: bool(p.managable),
		enabled: bool(p.enabled),
		blacklisted: bool(p.blacklisted),
		forcedDisabled: bool(p.forced_disabled),
		incompatible: bool(p.incompatible),
		safeModeVictim: bool(p.safe_mode_victim),
		pendingEnable: bool(p.pending_enable),
		pendingDisable: bool(p.pending_disable),
		pendingInstall: bool(p.pending_install),
		pendingUninstall: bool(p.pending_uninstall),
		disablingDiscouraged: typeof p.disabling_discouraged === 'string' && p.disabling_discouraged.trim() ? p.disabling_discouraged.trim() : null,
		origin: str(p.origin),
		notices
	};
}

/** `GET /plugin/pluginmanager/plugins` (or the old combined `GET /api/plugin/pluginmanager`). */
export function parsePluginList(raw: unknown): PluginList {
	const r = obj(raw);
	const plugins = (Array.isArray(r.plugins) ? r.plugins : []).map(parsePlugin).filter((p): p is InstalledPlugin => !!p);
	plugins.sort(byName);
	const pip = obj(r.pip);
	return {
		plugins,
		octoprint: str(r.octoprint),
		safeMode: bool(r.safe_mode),
		online: typeof r.online === 'boolean' ? r.online : null,
		pipAvailable: pip.available === undefined ? true : bool(pip.available)
	};
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Only http(s) links are shown as links (repository data is third-party). */
export function safeUrl(v: unknown): string | null {
	const s = str(v);
	if (!s) return null;
	try {
		const u = new URL(s);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
	} catch {
		return null;
	}
}

// --- rules ------------------------------------------------------------------------------------

/** What the switch does next: OctoPrint's own `_getToggleCommand`. */
export function toggleCommand(p: InstalledPlugin): 'enable' | 'disable' {
	const on = (p.enabled || p.pendingEnable || (p.safeModeVictim && !p.pendingDisable)) && !p.pendingDisable;
	return on ? 'disable' : 'enable';
}

/** Whether the plugin counts as on (after a restart, if one is pending). */
export const effectivelyEnabled = (p: InstalledPlugin) => toggleCommand(p) === 'disable';

/** Why the plugin can't be switched to `toggleCommand(p)`, or null when it can (OctoPrint's `enableToggle`). */
export function toggleBlocked(p: InstalledPlugin, safeMode = false): string | null {
	if (p.key === PLUGIN_MANAGER) return 'The Plugin Manager can’t be disabled';
	if (toggleCommand(p) === 'disable') return null;
	if (p.blacklisted) return 'On OctoPrint’s plugin blocklist (known to cause problems)';
	if (p.incompatible) return 'Not compatible with this OctoPrint or Python';
	if (p.safeModeVictim || safeMode) return 'OctoPrint is in safe mode: restart it normally first';
	return null;
}

/** Why the plugin can't be uninstalled, or null when it can (OctoPrint's `command_uninstall` checks). */
export function uninstallBlocked(p: InstalledPlugin): string | null {
	if (p.key === PLUGIN_MANAGER) return 'The Plugin Manager can’t be uninstalled';
	if (p.bundled) return 'Bundled with OctoPrint';
	if (!p.managable) return 'OctoPrint doesn’t manage this plugin';
	if (p.pendingUninstall) return 'Already uninstalled: restart OctoPrint to finish';
	return null;
}

export const isPending = (p: InstalledPlugin) => p.pendingEnable || p.pendingDisable || p.pendingInstall || p.pendingUninstall;

/** Plugins whose change waits for a restart of OctoPrint. */
export const pendingPlugins = (list: InstalledPlugin[]) => list.filter(isPending);

export type PluginFilter = 'all' | 'thirdparty' | 'bundled' | 'disabled' | 'pending';

/** The list, narrowed by a filter and a search (name, key, author, description). */
export function filterPlugins(list: InstalledPlugin[], query: string, filter: PluginFilter = 'all'): InstalledPlugin[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return list.filter((p) => {
		if (filter === 'thirdparty' && p.bundled) return false;
		if (filter === 'bundled' && !p.bundled) return false;
		if (filter === 'disabled' && effectivelyEnabled(p)) return false;
		if (filter === 'pending' && !isPending(p)) return false;
		if (!words.length) return true;
		const hay = `${p.name} ${p.key} ${p.author ?? ''} ${p.description}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

// --- the plugin repository -------------------------------------------------------------------

export interface RepoPlugin {
	id: string;
	title: string;
	description: string;
	author: string | null;
	/** What OctoPrint installs (a zip URL). */
	archive: string | null;
	homepage: string | null;
	/** The plugin's page on plugins.octoprint.org. */
	page: string | null;
	license: string | null;
	published: string | null;
	/** Instances using it last month (repository stats), when known. */
	installs: number | null;
	stars: number | null;
	/** OctoPrint's verdict for this server (octoprint, os, python), false when any says no. */
	compatible: boolean;
	incompatibleWith: string[];
	attributes: string[];
	abandoned: boolean;
}

export interface Repository {
	/** OctoPrint could fetch the repository (it needs the internet). */
	available: boolean;
	plugins: RepoPlugin[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseRepoPlugin(raw: unknown): RepoPlugin | null {
	const e = obj(raw);
	const id = str(e.id);
	if (!id) return null;
	const compat = obj(e.is_compatible);
	const incompatibleWith = (['octoprint', 'os', 'python'] as const).filter((k) => compat[k] === false);
	const labels: Record<string, string> = { octoprint: 'this OctoPrint version', os: 'this operating system', python: 'this Python version' };
	const attributes = Array.isArray(e.attributes) ? e.attributes.filter((a): a is string => typeof a === 'string') : [];
	const stats = obj(e.stats);
	const github = obj(e.github);
	return {
		id,
		title: str(e.title) ?? id,
		description: str(e.description) ?? '',
		author: str(e.author),
		archive: safeUrl(e.archive),
		homepage: safeUrl(e.homepage),
		page: safeUrl(e.page),
		license: str(e.license),
		published: str(e.published),
		installs: num(stats.instances_month) ?? num(stats.instances_week),
		stars: num(github.stars),
		compatible: incompatibleWith.length === 0,
		incompatibleWith: incompatibleWith.map((k) => labels[k]),
		attributes,
		abandoned: bool(e.abandoned) || attributes.includes('abandoned')
	};
}

/** `GET /plugin/pluginmanager/repository` → `{ repository: { available, plugins } }` (old combined answer too). */
export function parseRepository(raw: unknown): Repository {
	const r = obj(obj(raw).repository);
	const plugins = (Array.isArray(r.plugins) ? r.plugins : []).map(parseRepoPlugin).filter((p): p is RepoPlugin => !!p);
	return { available: bool(r.available) && plugins.length > 0, plugins };
}

/**
 * Searches the repository: every word must match the title, id, author or description; a
 * title or id match ranks first, then popularity. Without a query, the most used plugins.
 */
export function searchRepository(list: RepoPlugin[], query: string, limit = 50): RepoPlugin[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const scored = list
		.map((p) => {
			const title = `${p.title} ${p.id}`.toLowerCase();
			const hay = `${title} ${p.author ?? ''} ${p.description}`.toLowerCase();
			if (!words.every((w) => hay.includes(w))) return null;
			let score = 0;
			for (const w of words) score += title.includes(w) ? (title.startsWith(w) ? 30 : 20) : 2;
			if (!p.compatible) score -= 15;
			if (p.abandoned) score -= 10;
			return { p, score };
		})
		.filter((x): x is { p: RepoPlugin; score: number } => !!x);
	scored.sort((a, b) => b.score - a.score || (b.p.installs ?? 0) - (a.p.installs ?? 0) || a.p.title.localeCompare(b.p.title));
	return scored.slice(0, limit).map((x) => x.p);
}

/**
 * A plugin archive URL to install from: http(s) only, no credentials. Throws a readable error.
 * (OctoPrint downloads it itself; zip, tar.gz and whl archives and single .py files work.)
 */
export function validArchiveUrl(raw: unknown): string {
	const s = typeof raw === 'string' ? raw.trim() : '';
	if (!s) throw new Error('Paste the URL of a plugin archive (a .zip)');
	if (s.length > 2000) throw new Error('That URL is too long');
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		throw new Error('That isn’t a valid URL');
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The URL must start with https:// (or http://)');
	if (u.username || u.password) throw new Error('Leave credentials out of the URL');
	return u.toString();
}

// --- software updates ---------------------------------------------------------------------------

export interface UpdateTarget {
	key: string;
	name: string;
	/** The installed version (what OctoPrint shows). */
	current: string | null;
	/** The newest version, when known. */
	available: string | null;
	updateAvailable: boolean;
	/** OctoPrint can install it (configured, compatible, supported environment). */
	updatePossible: boolean;
	releaseNotes: string | null;
	/** "network", "ratelimit", "unknown"…: the check failed for this target. */
	error: string | null;
	disabled: boolean;
	compatible: boolean;
}

export type UpdateStatus = 'current' | 'updateAvailable' | 'updatePossible' | 'inProgress';

export interface UpdateCheck {
	status: UpdateStatus;
	/** OctoPrint itself, if it's among the targets. */
	octoprint: UpdateTarget | null;
	/** Every other target (plugins, pip…), by name. */
	targets: UpdateTarget[];
	/** When OctoPrint last asked upstream (its cache), ISO. */
	checkedAt: string | null;
	environmentSupported: boolean;
	storageSufficient: boolean;
}

const unknownVersion = (v: string | null) => (!v || v === '?' || v === 'unknown' ? null : v);

export function parseUpdateTarget(key: string, raw: unknown): UpdateTarget {
	const t = obj(raw);
	const info = obj(t.information);
	const local = obj(info.local);
	const remote = obj(info.remote);
	const current = unknownVersion(str(t.displayVersion)) ?? unknownVersion(str(local.name)) ?? unknownVersion(str(local.value));
	const available = unknownVersion(str(remote.name)) ?? unknownVersion(str(remote.value));
	return {
		key,
		name: str(t.displayName) ?? key,
		current,
		available,
		updateAvailable: bool(t.updateAvailable),
		updatePossible: bool(t.updatePossible),
		releaseNotes: safeUrl(t.releaseNotes) ?? safeUrl(remote.release_notes),
		error: str(t.error),
		disabled: bool(t.disabled),
		compatible: t.compatible === undefined ? true : bool(t.compatible)
	};
}

/** `GET /plugin/softwareupdate/check`. */
export function parseUpdateCheck(raw: unknown): UpdateCheck {
	const r = obj(raw);
	const information = obj(r.information);
	const all = Object.entries(information).map(([k, v]) => parseUpdateTarget(k, v));
	const octoprint = all.find((t) => t.key === 'octoprint') ?? null;
	const targets = all.filter((t) => t.key !== 'octoprint').sort(byName);
	const status = (['current', 'updateAvailable', 'updatePossible', 'inProgress'] as const).find((s) => s === r.status) ?? 'current';
	const ts = num(r.timestamp);
	const environment = obj(r.environment);
	const storage = obj(r.storage);
	return {
		status,
		octoprint,
		targets,
		checkedAt: ts ? new Date(ts * 1000).toISOString() : null,
		environmentSupported: environment.supported === undefined ? true : bool(environment.supported),
		storageSufficient: storage.sufficient === undefined ? true : bool(storage.sufficient)
	};
}

/** Every target with an update, OctoPrint first. */
export function availableUpdates(check: Pick<UpdateCheck, 'octoprint' | 'targets'> | null | undefined): UpdateTarget[] {
	if (!check) return [];
	return [...(check.octoprint ? [check.octoprint] : []), ...check.targets].filter((t) => t.updateAvailable && !t.disabled);
}

/**
 * The set of new versions on offer ("octoprint@1.11.3,octolapse@0.4.5"), sorted: a
 * notification goes out once per set, not again for the same versions.
 */
export function updateSignature(targets: UpdateTarget[]): string {
	return targets
		.filter((t) => t.updateAvailable)
		.map((t) => `${t.key}@${t.available ?? '?'}`)
		.sort()
		.join(',');
}

/** Why a target can't be updated from here, or null when it can. */
export function updateBlocked(t: UpdateTarget, check: Pick<UpdateCheck, 'environmentSupported' | 'storageSufficient'>): string | null {
	if (!t.updateAvailable) return 'Up to date';
	if (!check.environmentSupported) return 'OctoPrint can’t update itself in this Python environment';
	if (!check.storageSufficient) return 'Not enough free disk space on the OctoPrint host';
	if (!t.compatible) return 'The new version isn’t compatible with this OctoPrint or Python';
	if (!t.updatePossible) return 'OctoPrint can’t install this update itself (see its Software Update settings)';
	return null;
}

// --- push messages ----------------------------------------------------------------------------

export interface LogLine {
	line: string;
	/** message | call | stdout | stderr */
	stream: string;
}

export type ManagerMessage =
	| { kind: 'log'; lines: LogLine[] }
	| {
			kind: 'result';
			action: string;
			ok: boolean;
			/** A step of a multi-plugin install (a JSON list); the final result comes after. */
			partial: boolean;
			needsRestart: boolean;
			needsRefresh: boolean;
			reason: string | null;
			plugin: InstalledPlugin | null;
	  }
	| { kind: 'other'; type: string };

const lines = (v: unknown): LogLine[] =>
	(Array.isArray(v) ? v : [])
		.map((l) => obj(l))
		.filter((l) => typeof l.line === 'string')
		.map((l) => ({ line: String(l.line).slice(0, 2000), stream: str(l.stream) ?? 'stdout' }));

/** A Plugin Manager push message (`{ type: 'loglines' | 'result' | 'partial_result' | …, … }`). */
export function parseManagerMessage(raw: unknown): ManagerMessage | null {
	const d = obj(raw);
	const type = str(d.type);
	if (!type) return null;
	if (type === 'loglines') return { kind: 'log', lines: lines(d.loglines) };
	if (type === 'result' || type === 'partial_result') {
		return {
			kind: 'result',
			action: str(d.action) ?? 'unknown',
			ok: d.result === true,
			partial: type === 'partial_result',
			needsRestart: bool(d.needs_restart),
			needsRefresh: bool(d.needs_refresh),
			reason: str(d.reason),
			plugin: d.plugin && typeof d.plugin === 'object' ? parsePlugin(d.plugin) : null
		};
	}
	return { kind: 'other', type };
}

export type UpdaterMessage =
	| { kind: 'log'; lines: LogLine[] }
	/** One target is being updated now. */
	| { kind: 'updating'; target: string; name: string | null; version: string | null }
	| { kind: 'target_failed'; target: string; name: string | null; reason: string | null }
	/** All done, no restart needed. */
	| { kind: 'success' }
	| { kind: 'error' }
	/** OctoPrint restarts itself now. */
	| { kind: 'restarting' }
	| { kind: 'restart_failed' }
	/** No restart command configured: someone has to restart OctoPrint. */
	| { kind: 'restart_manually' }
	| { kind: 'other'; type: string };

/** A Software Update push message (`{ type, data }`). */
export function parseUpdaterMessage(raw: unknown): UpdaterMessage | null {
	const m = obj(raw);
	const type = str(m.type);
	if (!type) return null;
	const d = obj(m.data);
	switch (type) {
		case 'loglines':
			return { kind: 'log', lines: lines(d.loglines) };
		case 'updating':
			return { kind: 'updating', target: str(d.target) ?? '?', name: str(d.name), version: str(d.version) };
		case 'update_failed':
			return { kind: 'target_failed', target: str(d.target) ?? '?', name: str(d.name), reason: typeof d.reason === 'string' ? d.reason : d.reason != null ? JSON.stringify(d.reason).slice(0, 300) : null };
		case 'success':
		case 'error':
		case 'restarting':
		case 'restart_failed':
		case 'restart_manually':
			return { kind: type };
		default:
			return { kind: 'other', type };
	}
}

// --- what the API returns -----------------------------------------------------------------------

export type OpKind = 'install' | 'uninstall' | 'enable' | 'disable' | 'update' | 'restart';
export type OpPhase = 'running' | 'restarting' | 'done' | 'error';

/** A plugin or update action octo·modern started on one printer, with its live log. */
export interface PluginOp {
	id: number;
	kind: OpKind;
	/** What it acts on: a plugin name, an archive URL, "OctoPrint 1.11.3", "2 updates"… */
	label: string;
	phase: OpPhase;
	startedAt: string;
	startedBy: string | null;
	endedAt: string | null;
	log: LogLine[];
	/** The outcome, or why it failed. */
	message: string | null;
	needsRestart: boolean;
	/** Set once OctoPrint answers again after a restart. */
	newVersion: string | null;
}

/** Cached result of the last update check, kept per printer. */
export interface UpdateSummary {
	checkedAt: string;
	/** Versions on offer, OctoPrint first. */
	available: { key: string; name: string; current: string | null; available: string | null }[];
	error: string | null;
}

export const summarizeUpdates = (check: UpdateCheck, at = new Date()): UpdateSummary => ({
	checkedAt: at.toISOString(),
	available: availableUpdates(check).map((t) => ({ key: t.key, name: t.name, current: t.current, available: t.available })),
	error: null
});
