import { json } from '@sveltejs/kit';
import { BadRequest, body, handler, NotFound } from '#lib/server/http.ts';
import { audit, requirePrinter } from '#lib/server/permissions.ts';
import { requireAdmin } from '#lib/server/power/api.ts';
import { confirmRequired, currentState } from '#lib/server/control.ts';
import { backendFor, octoprintClient } from '#lib/server/backend/index.ts';
import { OctoPrintError } from '#lib/server/octoprint/errors.ts';
import {
	cachedUpdates,
	checkUpdates,
	hasRestartCommand,
	installPlugin,
	listPlugins,
	NOT_ADMIN,
	opState,
	repository,
	restartNeeded,
	restartOctoPrint,
	startUpdate,
	togglePlugin,
	uninstallPlugin
} from '#lib/server/plugins.ts';
import { availableUpdates, pendingPlugins, toggleBlocked, uninstallBlocked, updateBlocked, validArchiveUrl } from '#lib/plugins.ts';
import { jobActive } from '#lib/printer.ts';
import type { Printer, User } from '#lib/types.ts';
import type { RequestHandler } from './$types';

const noStore = { 'cache-control': 'no-store' };

function adminPrinter(user: User | null, id: string): Printer {
	requireAdmin(user);
	const p = requirePrinter(user, id);
	octoprintClient(p, 'Plugins & updates'); // 400 for Klipper printers
	return p;
}

/**
 * The printer's plugins: `{ access, octoprint, safeMode, online, pipAvailable, plugins,
 * restartNeeded, pending, restartCommand, op, updates, printing }`. When OctoPrint refuses
 * the key (not an admin's), `{ access: 'forbidden', message, hint }` instead. Admins only.
 */
export const GET: RequestHandler = handler(async ({ locals, params }) => {
	const printer = adminPrinter(locals.user, params.id);
	const [list, restart, state] = await Promise.all([
		listPlugins(printer).catch((err) => err as Error),
		hasRestartCommand(printer).catch(() => null),
		currentState(printer.id, backendFor(printer))
	]);
	const op = opState(printer.id);
	if (list instanceof OctoPrintError && list.code === NOT_ADMIN) {
		return json({ access: 'forbidden', message: list.message, hint: list.hint, op }, { headers: noStore });
	}
	if (list instanceof Error) throw list;
	return json(
		{
			access: 'ok',
			...list,
			restartNeeded: restartNeeded(printer.id, list.plugins),
			pending: pendingPlugins(list.plugins).length,
			restartCommand: restart,
			op,
			updates: cachedUpdates(printer.id),
			printing: jobActive(state)
		},
		{ headers: noStore }
	);
});

/** Plugin changes, updates and restarts wait until the printer is idle. */
async function ensureIdle(printer: Printer, what: string): Promise<Response | null> {
	const state = await currentState(printer.id, backendFor(printer));
	if (!jobActive(state)) return null;
	return json({ message: `${printer.name} is ${state === 'paused' ? 'paused mid-print' : 'printing'}: ${what} waits until the print is over.`, hint: 'OctoPrint could restart or reload plugins, which would ruin the print.' }, { status: 409 });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * `{ action, … , confirm? }`. Admins only; refused while printing.
 * - `enable` / `disable` `{ plugin }`
 * - `uninstall` `{ plugin, cleanup? }` (asks first)
 * - `install` `{ plugin }` from the repository, or `{ url }` (an archive; asks first)
 * - `update` `{ targets: string[] | 'all' }` (asks first)
 * - `restart` (asks first)
 */
export const POST: RequestHandler = handler(async ({ locals, params, request }) => {
	const printer = adminPrinter(locals.user, params.id);
	const b = await body(request);
	const by = locals.user?.name ?? locals.user?.email ?? null;
	const confirmed = b.confirm === true;
	const action = typeof b.action === 'string' ? b.action : '';
	const pluginKey = typeof b.plugin === 'string' ? b.plugin.trim() : '';

	async function installed(key: string) {
		if (!key) throw new BadRequest('Which plugin? Send { "plugin": "<key>" }');
		const list = await listPlugins(printer);
		const p = list.plugins.find((x) => x.key === key);
		if (!p) throw new NotFound(`No plugin “${key}” on this OctoPrint`);
		return { p, list };
	}

	switch (action) {
		case 'enable':
		case 'disable': {
			const busy = await ensureIdle(printer, 'enabling or disabling plugins');
			if (busy) return busy;
			const { p, list } = await installed(pluginKey);
			if (action === 'enable') {
				const why = toggleBlocked({ ...p, enabled: false, pendingEnable: false, pendingDisable: false }, list.safeMode);
				if (why) throw new BadRequest(why);
			} else if (p.key === 'pluginmanager') throw new BadRequest('The Plugin Manager can’t be disabled');
			const res = await togglePlugin(printer, p.key, action);
			audit(locals, `plugins.${action}`, { printer, detail: `${p.name} (${p.key})${res.needsRestart ? '; restart needed' : ''}` });
			return json(res);
		}
		case 'uninstall': {
			const busy = await ensureIdle(printer, 'uninstalling plugins');
			if (busy) return busy;
			const { p } = await installed(pluginKey);
			const why = uninstallBlocked(p);
			if (why) throw new BadRequest(why);
			const cleanup = b.cleanup === true;
			if (!confirmed) {
				return confirmRequired(`${p.name}${p.version ? ` ${p.version}` : ''} is removed from OctoPrint${cleanup ? ', with its settings and data' : ' (its settings and data stay)'}. OctoPrint may need a restart.`, {
					title: `Uninstall ${p.name}?`,
					confirmLabel: 'Uninstall'
				});
			}
			const op = await uninstallPlugin(printer, p, cleanup, by);
			audit(locals, 'plugins.uninstall', { printer, detail: `${p.name} (${p.key})${cleanup ? ' with its settings and data' : ''}: ${op.phase === 'done' ? 'done' : (op.message ?? 'failed')}` });
			return json({ op });
		}
		case 'install': {
			const busy = await ensureIdle(printer, 'installing plugins');
			if (busy) return busy;
			if (pluginKey) {
				const repo = await repository(printer);
				const entry = repo.plugins.find((x) => x.id === pluginKey);
				if (!entry) throw new NotFound(repo.available ? `“${pluginKey}” isn’t in the plugin repository` : 'OctoPrint couldn’t load the plugin repository (it needs the internet)');
				if (!entry.archive) throw new BadRequest(`${entry.title} has no download in the repository`);
				if (!entry.compatible) throw new BadRequest(`${entry.title} isn’t compatible with ${entry.incompatibleWith.join(', ')}`);
				const op = await installPlugin(printer, { url: entry.archive, label: entry.title, pluginId: entry.id, fromRepo: true }, by);
				audit(locals, 'plugins.install', { printer, detail: `${entry.title} (${entry.id}) from the repository: ${entry.archive}`.slice(0, 480) });
				return json({ op }, { status: 202 });
			}
			let url: string;
			try {
				url = validArchiveUrl(b.url);
			} catch (err) {
				throw new BadRequest((err as Error).message);
			}
			if (!confirmed) {
				return confirmRequired('Plugins run with OctoPrint’s full rights on its host (often the Raspberry Pi next to the printer): they can read its files, control the printer and reach your network. Only install archives from sources you trust.', {
					title: 'Install a plugin from a URL?',
					confirmLabel: 'Install'
				});
			}
			const op = await installPlugin(printer, { url, label: url.split('/').pop()?.slice(0, 80) || url, fromRepo: false }, by);
			audit(locals, 'plugins.install', { printer, detail: `from URL ${url}`.slice(0, 480) });
			return json({ op }, { status: 202 });
		}
		case 'update': {
			const busy = await ensureIdle(printer, 'updating');
			if (busy) return busy;
			const check = await checkUpdates(printer, false);
			const offered = availableUpdates(check);
			const wanted = b.targets === 'all' ? offered.map((t) => t.key) : Array.isArray(b.targets) ? b.targets.filter((t): t is string => typeof t === 'string') : [];
			if (!wanted.length) throw new BadRequest(b.targets === 'all' ? 'No updates available' : 'Which updates? Send { "targets": ["octoprint", …] } or "all"');
			const targets = wanted.map((key) => {
				const t = offered.find((x) => x.key === key);
				if (!t) throw new BadRequest(`No update available for “${key}” (check again)`);
				const why = updateBlocked(t, check);
				if (why) throw new BadRequest(`${t.name}: ${why}`);
				return t;
			});
			const list = targets.map((t) => `${t.name} ${t.current ?? '?'} → ${t.available ?? '?'}`);
			const label = targets.length === 1 ? `${targets[0].name} ${targets[0].available ?? ''}`.trim() : plural(targets.length, 'update');
			if (!confirmed) {
				return confirmRequired(`OctoPrint installs ${list.join(', ')}, then restarts itself (when its restart command is set): the printer disconnects for a minute.`, {
					title: `Update ${targets.length === 1 ? targets[0].name : plural(targets.length, 'target')} on ${printer.name}?`,
					confirmLabel: targets.length === 1 ? 'Update' : 'Update all'
				});
			}
			const op = await startUpdate(printer, targets.map((t) => t.key), label, by);
			audit(locals, 'octoprint.update', { printer, detail: list.join('; ').slice(0, 480) });
			return json({ op }, { status: 202 });
		}
		case 'restart': {
			const busy = await ensureIdle(printer, 'restarting OctoPrint');
			if (busy) return busy;
			if (!(await hasRestartCommand(printer))) {
				return json({ message: 'OctoPrint has no restart command configured', code: 'NO_RESTART_COMMAND', hint: 'Set one in OctoPrint → Settings → Server → Commands (OctoPi: sudo service octoprint restart), or restart OctoPrint on its host.' }, { status: 409 });
			}
			if (!confirmed) {
				return confirmRequired('OctoPrint stops and starts again: the printer disconnects, and it’s back in a minute or so.', { title: `Restart OctoPrint on ${printer.name}?`, confirmLabel: 'Restart' });
			}
			const op = await restartOctoPrint(printer, by);
			audit(locals, 'octoprint.restart', { printer });
			return json({ op }, { status: 202 });
		}
		default:
			throw new BadRequest('Unknown action: use enable, disable, uninstall, install, update or restart');
	}
});
