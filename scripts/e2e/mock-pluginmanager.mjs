// OctoPrint's bundled Plugin Manager, Software Update and system commands, for the mock OctoPrint
// (`startMockOctoPrint({ pluginManager: { … } })`), the plugins tests and `pnpm e2e:plugins`.
// Answers with the shapes of OctoPrint 1.11 (checked against its source and a real 1.11.8):
//
//   GET  /plugin/pluginmanager/plugins       { plugins, octoprint, safe_mode, online, pip, … }
//   GET  /plugin/pluginmanager/repository    { repository: { available, plugins } }
//   POST /api/plugin/pluginmanager           install | uninstall | enable | disable (+ cleanup)
//   GET  /plugin/softwareupdate/check        { status, information, timestamp, environment, storage }
//   POST /plugin/softwareupdate/update       { order, checks } (202 { queued } while printing)
//   GET  /api/system/commands/core           [{ action: 'restart', … }] when `restartCommand`
//   POST /api/system/commands/core/restart
//
// Installs and updates push Plugin Manager / Software Update messages (loglines, result,
// updating, restarting…) on the push socket, take `installMs` / `updateMs`, and a restart takes
// OctoPrint away for `restartMs` (connections reset), then applies pending changes and new versions.
// `legacy: true` answers like OctoPrint < 1.6 (only the combined GET /api/plugin/pluginmanager);
// `forbidden: true` refuses every call like a non-admin key (403). Nothing is downloaded: install
// URLs containing "fail" fail; others "install" a made-up plugin.

const ext = (p) => ({
	key: p.key,
	name: p.name ?? p.key,
	description: p.description ?? '',
	disabling_discouraged: p.disabling_discouraged ?? false,
	author: p.author ?? null,
	version: p.version ?? null,
	url: p.url ?? null,
	license: p.license ?? 'AGPLv3',
	privacypolicy: null,
	python: '>=3.7,<4',
	bundled: !!p.bundled,
	managable: p.managable ?? !p.bundled,
	enabled: p.enabled ?? true,
	blacklisted: !!p.blacklisted,
	forced_disabled: false,
	incompatible: !!p.incompatible,
	safe_mode_victim: false,
	pending_enable: !!p.pending_enable,
	pending_disable: !!p.pending_disable,
	pending_install: !!p.pending_install,
	pending_uninstall: !!p.pending_uninstall,
	origin: p.bundled ? 'module' : 'entry_point',
	notifications: p.notifications ?? null,
	attributes: []
});

const repoEntry = (r) => ({
	id: r.id,
	title: r.title ?? r.id,
	description: r.description ?? '',
	author: r.author ?? 'Someone',
	archive: r.archive ?? `https://github.com/example/OctoPrint-${r.id}/archive/master.zip`,
	homepage: r.homepage ?? `https://github.com/example/OctoPrint-${r.id}`,
	page: `https://plugins.octoprint.org/plugins/${r.id}/`,
	license: r.license ?? 'AGPLv3',
	published: r.published ?? '2023-01-01',
	follow_dependency_links: false,
	no_build_isolation: false,
	privacypolicy: false,
	compatibility: { octoprint: ['>=1.4.0'], os: [], python: '>=3,<4' },
	is_compatible: { octoprint: r.compatible !== false, os: true, python: true },
	attributes: r.attributes ?? [],
	stats: { instances_month: r.installs ?? 100, instances_week: Math.round((r.installs ?? 100) / 4) },
	github: { stars: r.stars ?? 10 }
});

/**
 * - `plugins`: installed plugins ({ key, name, version, bundled, enabled, … })
 * - `repository`: repository entries ({ id, title, author, description, installs, stars, compatible })
 * - `updates`: { target: { name, available, releaseNotes, possible } } (target `octoprint` is OctoPrint)
 */
export function createPluginManager(opts, ctx) {
	const pm = {
		plugins: (opts.plugins ?? []).map(ext),
		repository: (opts.repository ?? []).map(repoEntry),
		repositoryAvailable: opts.repositoryAvailable ?? true,
		updates: structuredClone(opts.updates ?? {}),
		restartCommand: opts.restartCommand ?? true,
		forbidden: !!opts.forbidden,
		legacy: !!opts.legacy,
		installMs: opts.installMs ?? 1500,
		updateMs: opts.updateMs ?? 2000,
		restartMs: opts.restartMs ?? 2500,
		/** Calls received: { command, … } bodies and update/restart requests. */
		calls: [],
		installing: false,
		updating: false,
		/** Applied on the next restart. */
		afterRestart: [],
		restarts: 0,
		checkedAt: Date.now() / 1000 - 3 * 3600,
		forcedChecks: 0
	};
	const managerMsg = (data) => ctx.push({ plugin: { plugin: 'pluginmanager', data } });
	const updaterMsg = (type, data = null) => ctx.push({ plugin: { plugin: 'softwareupdate', data: { type, data } } });
	const log = (lines, stream = 'stdout') => managerMsg({ type: 'loglines', loglines: lines.map((line) => ({ line, stream })) });
	const ulog = (lines, stream = 'stdout') => updaterMsg('loglines', { loglines: lines.map((line) => ({ line, stream })) });
	const later = (ms, fn) => setTimeout(fn, ms).unref?.();
	const find = (key) => pm.plugins.find((p) => p.key === key);

	function pluginResponse() {
		return {
			plugins: pm.plugins,
			os: 'linux',
			octoprint: ctx.version(),
			pip: { available: true, version: '23.0.1', install_dir: '/home/pi/oprint/lib/python3.11/site-packages', use_user: false, virtual_env: true, additional_args: null, python: '/home/pi/oprint/bin/python3' },
			safe_mode: false,
			online: true,
			supported_extensions: { archive: ['.zip', '.tar.gz', '.tgz', '.tar', '.gz', '.whl'], python: ['.py'], json: ['.json'] }
		};
	}

	function information() {
		const out = {};
		const local = { octoprint: ctx.version() };
		const targets = { octoprint: { name: 'OctoPrint' }, ...Object.fromEntries(pm.plugins.filter((p) => !p.bundled || pm.updates[p.key]).map((p) => [p.key, { name: `${p.name} Plugin` }])) };
		for (const [key, t] of Object.entries(targets)) {
			const current = key === 'octoprint' ? local.octoprint : (find(key)?.version ?? '?');
			const u = pm.updates[key];
			out[key] = {
				updateAvailable: !!u,
				updatePossible: !!u && u.possible !== false,
				information: { local: { name: current, value: current }, remote: { name: u?.available ?? current, value: u?.available ?? current, release_notes: u?.releaseNotes ?? null }, needs_online: true },
				displayName: t.name,
				displayVersion: current,
				releaseNotes: u?.releaseNotes ?? null,
				online: true,
				error: null,
				disabled: false,
				compatible: true,
				releaseChannels: {}
			};
		}
		return out;
	}

	function restart() {
		pm.restarts++;
		ctx.goDown(pm.restartMs, () => {
			for (const fn of pm.afterRestart.splice(0)) fn();
			pm.plugins = pm.plugins
				.filter((p) => !p.pending_uninstall)
				.map((p) => ({ ...p, enabled: p.pending_enable ? true : p.pending_disable ? false : p.enabled, pending_enable: false, pending_disable: false, pending_install: false }));
		});
	}

	function install(url, body) {
		pm.installing = true;
		const entry = pm.repository.find((r) => r.archive === url);
		const fails = /fail/i.test(url);
		const key = entry?.id ?? (/OctoPrint-([A-Za-z0-9_]+)/.exec(url)?.[1] ?? 'custom').toLowerCase();
		const name = entry?.title ?? `${key[0].toUpperCase()}${key.slice(1)}`;
		log([`Installing plugin from ${url}`], 'message');
		later(pm.installMs * 0.3, () => log([`/home/pi/oprint/bin/python3 -m pip install ${url} --no-cache-dir`], 'call'));
		later(pm.installMs * 0.5, () => log(fails ? ['ERROR: Could not install packages: HTTP error 404 while getting the archive'] : [`Collecting ${url}`, `  Downloading ${url.split('/').pop()}`, `Building wheel for OctoPrint-${name.replace(/\W+/g, '')} (pyproject.toml): finished`], fails ? 'stderr' : 'stdout'));
		later(pm.installMs, () => {
			pm.installing = false;
			if (fails) {
				managerMsg({ type: 'result', action: 'install', result: false, source: url, source_type: 'url', reason: 'Could not install plugin from URL, see the log for more details' });
				return;
			}
			const plugin = ext({ key, name, version: '1.0.0', author: entry?.author ?? 'Someone', description: entry?.description ?? 'Installed from a URL', pending_install: true });
			pm.plugins = [...pm.plugins.filter((p) => p.key !== key), plugin];
			log([`Successfully installed OctoPrint-${name.replace(/\W+/g, '')}-1.0.0`]);
			managerMsg({ type: 'result', action: 'install', result: true, source: url, source_type: 'url', needs_restart: true, needs_refresh: true, needs_reconnect: false, was_reinstalled: false, plugin });
		});
		return { in_progress: true };
	}

	function update(targets) {
		pm.updating = true;
		const order = ['octoprint', ...targets.filter((t) => t !== 'octoprint').sort()].filter((t) => targets.includes(t) && pm.updates[t]);
		let at = 0;
		const step = pm.updateMs / Math.max(1, order.length + 1);
		for (const t of order) {
			const u = pm.updates[t];
			later((at += step), () => {
				const name = t === 'octoprint' ? 'OctoPrint' : `${find(t)?.name ?? t} Plugin`;
				updaterMsg('updating', { target: t, version: u.available, name });
				ulog([`/home/pi/oprint/bin/python3 -m pip install ${t === 'octoprint' ? 'OctoPrint' : `OctoPrint-${t}`}==${u.available}`], 'call');
				ulog([`Successfully installed ${t === 'octoprint' ? 'OctoPrint' : `OctoPrint-${t}`}-${u.available}`]);
				pm.afterRestart.push(() => {
					if (t === 'octoprint') ctx.setVersion(u.available);
					else {
						const p = find(t);
						if (p) p.version = u.available;
					}
					delete pm.updates[t];
				});
			});
		}
		later(pm.updateMs, () => {
			pm.updating = false;
			if (pm.restartCommand) {
				updaterMsg('restarting', { restart_type: 'octoprint', results: {} });
				later(100, restart);
			} else updaterMsg('restart_manually', { restart_type: 'octoprint', results: {} });
		});
		return { order, checks: Object.fromEntries(order.map((t) => [t, t])) };
	}

	/** Handles a request; returns false when it isn't one of ours. */
	function handle(req, p, url, body, res, send) {
		const ours = p.startsWith('/plugin/pluginmanager') || p.startsWith('/plugin/softwareupdate') || p === '/api/plugin/pluginmanager' || p.startsWith('/api/system');
		if (!ours) return false;
		if (pm.forbidden) return send({ error: 'You don’t have the permission to access the requested resource. It is either read-protected or not readable by the server.' }, 403), true;
		const json = () => JSON.parse(body || '{}');
		if (p === '/plugin/pluginmanager/plugins' && req.method === 'GET') {
			if (pm.legacy) return send({ error: 'Not found' }, 404), true;
			return send(pluginResponse()), true;
		}
		if (p === '/plugin/pluginmanager/repository' && req.method === 'GET') {
			if (pm.legacy) return send({ error: 'Not found' }, 404), true;
			return send({ repository: { available: pm.repositoryAvailable, plugins: pm.repositoryAvailable ? pm.repository : [] } }), true;
		}
		if (p === '/api/plugin/pluginmanager' && req.method === 'GET') {
			return send({ ...pluginResponse(), orphan_data: {}, repository: { available: pm.repositoryAvailable, plugins: pm.repositoryAvailable ? pm.repository : [] } }), true;
		}
		if (p === '/api/plugin/pluginmanager' && req.method === 'POST') {
			const b = json();
			pm.calls.push(b);
			// Like OctoPrint: an install while printing is queued until the print ends.
			if (ctx.printing() && b.command === 'install') return send({ queued_installs: [b] }, 202), true;
			if (b.command === 'install') {
				if (pm.installing) return send({ error: 'There’s already a plugin being installed' }, 409), true;
				return send(install(b.url, b)), true;
			}
			const plugin = find(b.plugin);
			if (!plugin) return send({ error: 'Unknown plugin' }, 404), true;
			if (b.command === 'uninstall') {
				if (plugin.key === 'pluginmanager') return send({ error: 'Can’t uninstall Plugin Manager' }, 403), true;
				if (!plugin.managable) return send({ error: 'Plugin is not managable and hence cannot be uninstalled' }, 403), true;
				if (plugin.bundled) return send({ error: 'Bundled plugins cannot be uninstalled' }, 403), true;
				log([`Deleting plugin from /home/pi/.octoprint/plugins/${plugin.key}`]);
				plugin.pending_uninstall = true;
				const result = { result: true, needs_restart: true, needs_refresh: true, needs_reconnect: false, plugin };
				managerMsg({ type: 'result', action: 'uninstall', ...result });
				return send(result), true;
			}
			if (b.command === 'enable' || b.command === 'disable') {
				if (plugin.key === 'pluginmanager') return send({ error: 'Can’t enable/disable Plugin Manager' }, 400), true;
				const restartNeeding = !!opts.restartNeeding?.includes(plugin.key);
				const turnOn = b.command === 'enable';
				if (turnOn && plugin.pending_disable) plugin.pending_disable = false;
				else if (!turnOn && plugin.pending_enable) plugin.pending_enable = false;
				else if (restartNeeding) {
					if (turnOn) plugin.pending_enable = true;
					else plugin.pending_disable = true;
				} else plugin.enabled = turnOn;
				const result = { result: true, needs_restart: restartNeeding, needs_refresh: true, needs_reconnect: false, plugin };
				managerMsg({ type: 'result', action: b.command, ...result });
				return send(result), true;
			}
			return send({ error: 'Unknown command' }, 400), true;
		}
		if (p === '/plugin/softwareupdate/check' && req.method === 'GET') {
			if (url.searchParams.get('force') === 'true') {
				pm.forcedChecks++;
				pm.checkedAt = Date.now() / 1000;
			}
			const info = information();
			const available = Object.values(info).some((t) => t.updateAvailable);
			return send({ status: pm.updating ? 'inProgress' : available ? 'updatePossible' : 'current', information: info, timestamp: pm.checkedAt, environment: { supported: true, versions: [] }, storage: { sufficient: true, free: [] } }), true;
		}
		if (p === '/plugin/softwareupdate/update' && req.method === 'POST') {
			const b = json();
			pm.calls.push({ update: b.targets });
			if (ctx.printing()) return send({ queued: b.targets }, 202), true;
			return send(update(Array.isArray(b.targets) ? b.targets : Object.keys(pm.updates))), true;
		}
		if (p === '/api/system/commands/core' && req.method === 'GET') {
			return send(pm.restartCommand ? [{ action: 'restart', name: 'Restart OctoPrint', confirm: 'You are about to restart the OctoPrint server.', source: 'core', resource: `${ctx.url()}/api/system/commands/core/restart` }] : []), true;
		}
		if (p === '/api/system/commands' && req.method === 'GET') {
			return send({ core: pm.restartCommand ? [{ action: 'restart', name: 'Restart OctoPrint', source: 'core' }] : [], custom: [], plugin: [] }), true;
		}
		if (p === '/api/system/commands/core/restart' && req.method === 'POST') {
			pm.calls.push({ restart: true });
			if (!pm.restartCommand) return send({ error: 'Command for core:restart not found' }, 404), true;
			res.writeHead(204).end();
			later(200, restart);
			return true;
		}
		return send({ error: 'Not found' }, 404), true;
	}
	return { handle, state: pm, restart };
}
