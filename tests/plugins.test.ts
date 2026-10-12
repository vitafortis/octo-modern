// Care › Plugins & updates: parsing what OctoPrint's Plugin Manager and Software Update answer
// (fixtures recorded from a real OctoPrint 1.11.8 container), the rules the UI and server share,
// and the server flows against the mock OctoPrint: list, toggle, uninstall, install with live
// log lines over the push socket, updates that restart OctoPrint, restarts, a key that isn't an
// admin's, and the "updates available" notification (once per set of versions).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-plugins-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-plugins';
const lib = await import('../src/lib/plugins.ts');
const store = await import('../src/lib/server/store.ts');
const srv = await import('../src/lib/server/plugins.ts');
const notifySettings = await import('../src/lib/server/notify/settings.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const { adminOnlyApi } = await import('../src/lib/server/access.ts');
const tabs = await import('../src/lib/printer-tabs.ts');
const kind = await import('../src/lib/printer-kind.ts');
const { EVENT_KINDS, EVENT_INFO } = await import('../src/lib/notify.ts');
// @ts-expect-error: plain JS mock
const { startMockOctoPrint } = await import('../scripts/e2e/mock-octoprint.mjs');

// Ports 4510–4529 (this feature's range is 4500–4599).
const HOOK_PORT = 4520;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | Promise<T>, label: string, ms = 15_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out: ${label}`);
		await sleep(50);
	}
}

Object.assign(srv.timing, { pollMs: 100, restartGraceMs: 2_000, updateStartGraceMs: 1_500, opTimeoutMs: 20_000, restartTimeoutMs: 20_000 });

// --- parsing real answers -------------------------------------------------------------------------

test('plugin list: OctoPrint 1.11.8’s answer (firmware_check disabled, waiting for a restart)', () => {
	const list = lib.parsePluginList(fixture('pluginmanager-plugins.json'));
	assert.equal(list.octoprint, '1.11.8');
	assert.equal(list.safeMode, false);
	assert.equal(list.pipAvailable, true);
	assert.equal(list.plugins.length, 21);
	// Sorted by name.
	const names = list.plugins.map((p) => p.name);
	assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
	const gv = list.plugins.find((p) => p.key === 'gcodeviewer')!;
	assert.equal(gv.bundled, true);
	assert.equal(gv.managable, false);
	assert.equal(gv.version, null);
	assert.match(gv.disablingDiscouraged!, /GCode Viewer/);
	assert.equal(lib.uninstallBlocked(gv), 'Bundled with OctoPrint');
	assert.equal(lib.toggleBlocked(gv), null, 'bundled plugins can still be disabled');
	const fw = list.plugins.find((p) => p.key === 'firmware_check')!;
	assert.equal(fw.enabled, true);
	assert.equal(fw.pendingDisable, true);
	assert.equal(lib.toggleCommand(fw), 'enable', 'switching it back on cancels the pending disable');
	assert.equal(lib.effectivelyEnabled(fw), false);
	assert.equal(lib.pendingPlugins(list.plugins).length, 1);
	assert.equal(fw.url, 'https://github.com/OctoPrint/OctoPrint-FirmwareCheck');
});

test('update check: OctoPrint 1.11.8 without internet (every target "network", nothing on offer)', () => {
	const c = lib.parseUpdateCheck(fixture('softwareupdate-check-offline.json'));
	assert.equal(c.status, 'current');
	assert.equal(c.octoprint?.current, '1.11.8');
	assert.equal(c.octoprint?.available, null, '"?" is unknown');
	assert.equal(c.octoprint?.error, 'network');
	assert.deepEqual(c.targets.map((t) => t.key), ['file_check', 'firmware_check']);
	assert.equal(c.targets[0].current, '2025.7.23');
	assert.equal(c.environmentSupported, true);
	assert.equal(c.storageSufficient, true);
	assert.match(c.checkedAt!, /^20\d\d-/);
	assert.deepEqual(lib.availableUpdates(c), []);
	assert.equal(lib.updateSignature(lib.availableUpdates(c)), '');
});

test('update targets: versions, release notes (http only), what blocks an update', () => {
	const t = lib.parseUpdateTarget('octolapse', {
		displayName: 'Octolapse',
		displayVersion: '0.4.4',
		updateAvailable: true,
		updatePossible: true,
		information: { local: { name: '0.4.4', value: '0.4.4' }, remote: { name: 'v0.4.5', value: '0.4.5' } },
		releaseNotes: 'https://github.com/FormerLurker/Octolapse/releases/tag/v0.4.5'
	});
	assert.equal(t.current, '0.4.4');
	assert.equal(t.available, 'v0.4.5');
	assert.equal(t.releaseNotes, 'https://github.com/FormerLurker/Octolapse/releases/tag/v0.4.5');
	assert.equal(lib.parseUpdateTarget('x', { releaseNotes: 'javascript:alert(1)' }).releaseNotes, null);
	const ok = { environmentSupported: true, storageSufficient: true };
	assert.equal(lib.updateBlocked(t, ok), null);
	assert.match(lib.updateBlocked(t, { ...ok, storageSufficient: false })!, /disk space/);
	assert.match(lib.updateBlocked({ ...t, updatePossible: false }, ok)!, /can’t install/);
	assert.equal(lib.updateBlocked({ ...t, updateAvailable: false }, ok), 'Up to date');
	// The signature ignores order and only counts what's on offer.
	const a = { ...t, key: 'a', available: '2' };
	const b = { ...t, key: 'b', available: '3' };
	assert.equal(lib.updateSignature([a, b]), lib.updateSignature([b, a]));
	assert.equal(lib.updateSignature([a, { ...b, updateAvailable: false }]), 'a@2');
});

test('rules: toggling, uninstalling, filtering', () => {
	const base = lib.parsePlugin({ key: 'octolapse', name: 'Octolapse', bundled: false, managable: true, enabled: true, author: 'FormerLurker', description: 'Stabilized timelapses' })!;
	assert.equal(lib.toggleCommand(base), 'disable');
	assert.equal(lib.uninstallBlocked(base), null);
	assert.match(lib.uninstallBlocked({ ...base, pendingUninstall: true })!, /restart/);
	assert.match(lib.uninstallBlocked({ ...base, managable: false })!, /doesn’t manage/);
	assert.match(lib.uninstallBlocked({ ...base, key: 'pluginmanager' })!, /Plugin Manager/);
	const off = { ...base, enabled: false };
	assert.equal(lib.toggleCommand(off), 'enable');
	assert.equal(lib.toggleCommand({ ...off, pendingEnable: true }), 'disable');
	assert.match(lib.toggleBlocked({ ...off, blacklisted: true })!, /blocklist/);
	assert.match(lib.toggleBlocked({ ...off, incompatible: true })!, /compatible/);
	assert.match(lib.toggleBlocked(off, true)!, /safe mode/);
	assert.equal(lib.toggleBlocked({ ...base, incompatible: true }), null, 'disabling is always fine');
	const bundled = { ...base, key: 'logging', name: 'Logging', bundled: true, author: 'Gina Häußge', description: 'Log files' };
	const list = [base, off && { ...off, key: 'dlp', name: 'DisplayLayerProgress', author: 'OllisGit', description: 'Layer progress' }, bundled, { ...base, key: 'obico', name: 'Obico', pendingInstall: true }];
	assert.deepEqual(lib.filterPlugins(list, '').length, 4);
	assert.deepEqual(lib.filterPlugins(list, 'layer').map((p) => p.key), ['dlp']);
	assert.deepEqual(lib.filterPlugins(list, 'gina log').map((p) => p.key), ['logging']);
	assert.deepEqual(lib.filterPlugins(list, '', 'bundled').map((p) => p.key), ['logging']);
	assert.deepEqual(lib.filterPlugins(list, '', 'thirdparty').length, 3);
	assert.deepEqual(lib.filterPlugins(list, '', 'disabled').map((p) => p.key), ['dlp']);
	assert.deepEqual(lib.filterPlugins(list, '', 'pending').map((p) => p.key), ['obico']);
	// Only http(s) homepages become links.
	assert.equal(lib.parsePlugin({ key: 'x', url: 'javascript:alert(1)' })!.url, null);
	assert.equal(lib.parsePlugin({ name: 'no key' }), null);
	// Notices lose their markup.
	assert.equal(lib.parsePlugin({ key: 'x', notifications: [{ text: '<b>Broken</b> on 1.11', link: 'https://x.org', important: true }] })!.notices[0].text, 'Broken on 1.11');
});

test('repository: compatibility, abandoned, search ranking; archive URLs', () => {
	const repo = lib.parseRepository({
		repository: {
			available: true,
			plugins: [
				{ id: 'octolapse', title: 'Octolapse', author: 'FormerLurker', description: 'Create stabilized timelapses', archive: 'https://github.com/FormerLurker/Octolapse/archive/master.zip', is_compatible: { octoprint: true, os: true, python: true }, stats: { instances_month: 30000 }, github: { stars: 700 } },
				{ id: 'timelapseplus', title: 'Timelapse+', author: 'Someone', description: 'More timelapse options', is_compatible: { octoprint: true, os: true, python: false }, stats: { instances_month: 400 } },
				{ id: 'oldthing', title: 'Old Thing', description: 'a timelapse helper', attributes: ['abandoned'], is_compatible: { octoprint: true, os: true, python: true }, stats: { instances_month: 90000 } },
				{ id: 'bedlevelvisualizer', title: 'Bed Visualizer', author: 'jneilliii', description: 'Displays 3D mesh of bed topography', is_compatible: { octoprint: true, os: true, python: true }, stats: { instances_month: 60000 } },
				{ title: 'no id' }
			]
		}
	});
	assert.equal(repo.available, true);
	assert.equal(repo.plugins.length, 4);
	const tlp = repo.plugins.find((p) => p.id === 'timelapseplus')!;
	assert.equal(tlp.compatible, false);
	assert.deepEqual(tlp.incompatibleWith, ['this Python version']);
	assert.equal(tlp.archive, null);
	assert.equal(repo.plugins.find((p) => p.id === 'oldthing')!.abandoned, true);
	const hits = lib.searchRepository(repo.plugins, 'timelapse');
	assert.deepEqual(hits.map((p) => p.id).sort(), ['octolapse', 'oldthing', 'timelapseplus'], 'all three match');
	assert.equal(hits[0].id, 'timelapseplus', 'a title match ranks first…');
	assert.ok(hits.findIndex((p) => p.id === 'octolapse') < hits.findIndex((p) => p.id === 'oldthing'), '…and abandoned ones sink');
	assert.deepEqual(lib.searchRepository(repo.plugins, 'bed mesh').map((p) => p.id), ['bedlevelvisualizer']);
	assert.equal(lib.searchRepository(repo.plugins, '')[0].id, 'bedlevelvisualizer', 'no query: the most used compatible, maintained plugin first');
	assert.equal(lib.parseRepository({ repository: { available: true, plugins: [] } }).available, false);
	assert.equal(lib.validArchiveUrl(' https://github.com/a/b/archive/main.zip '), 'https://github.com/a/b/archive/main.zip');
	for (const bad of ['', 'not a url', 'ftp://x/y.zip', 'file:///etc/passwd', 'https://u:p@host/x.zip', 42]) assert.throws(() => lib.validArchiveUrl(bad), String(bad));
});

test('push messages: Plugin Manager log lines and results, Software Update progress', () => {
	assert.deepEqual(lib.parseManagerMessage({ type: 'loglines', loglines: [{ line: 'Collecting x', stream: 'stdout' }, { nope: 1 }] }), { kind: 'log', lines: [{ line: 'Collecting x', stream: 'stdout' }] });
	const r = lib.parseManagerMessage({ type: 'result', action: 'install', result: true, needs_restart: true, plugin: { key: 'obico', name: 'Obico', version: '2.5.0' } });
	assert.equal(r?.kind, 'result');
	if (r?.kind === 'result') {
		assert.equal(r.ok, true);
		assert.equal(r.needsRestart, true);
		assert.equal(r.partial, false);
		assert.equal(r.plugin?.version, '2.5.0');
	}
	const p = lib.parseManagerMessage({ type: 'partial_result', action: 'install', result: false, reason: 'pip failed' });
	assert.ok(p?.kind === 'result' && p.partial && !p.ok && p.reason === 'pip failed');
	assert.deepEqual(lib.parseManagerMessage({ type: 'queued_installs', queued: [] }), { kind: 'other', type: 'queued_installs' });
	assert.equal(lib.parseManagerMessage('x'), null);
	assert.deepEqual(lib.parseUpdaterMessage({ type: 'updating', data: { target: 'octoprint', version: '1.11.3', name: 'OctoPrint' } }), { kind: 'updating', target: 'octoprint', name: 'OctoPrint', version: '1.11.3' });
	assert.deepEqual(lib.parseUpdaterMessage({ type: 'restarting', data: { restart_type: 'octoprint' } }), { kind: 'restarting' });
	assert.deepEqual(lib.parseUpdaterMessage({ type: 'update_failed', data: { target: 'x', reason: { code: 1 } } }), { kind: 'target_failed', target: 'x', name: null, reason: '{"code":1}' });
	assert.equal(lib.parseUpdaterMessage({ type: 'loglines', data: { loglines: [{ line: 'ok', stream: 'call' }] } })?.kind, 'log');
});

test('access, tabs and the notification kind', () => {
	for (const m of ['GET', 'POST']) {
		assert.equal(adminOnlyApi(m, '/api/printers/abc/plugins'), true, m);
		assert.equal(adminOnlyApi(m, '/api/printers/abc/plugins/repository'), true, m);
	}
	assert.equal(adminOnlyApi('GET', '/api/printers/abc/pluginsx'), false);
	const care = (features: Record<string, boolean>, k: 'octoprint' | 'moonraker') => tabs.tabsFor(features, kind.hiddenTabs({ kind: k })).find((t) => t.id === 'care')!.views!.map((v) => v.id);
	assert.deepEqual(care({ bedmesh: true, plugins: true }, 'octoprint'), ['maintenance', 'bed', 'plugins']);
	assert.deepEqual(care({ plugins: false }, 'octoprint'), ['maintenance'], 'not for operators and viewers');
	assert.deepEqual(care({ plugins: true }, 'moonraker'), ['maintenance'], 'not for Klipper');
	assert.equal(tabs.printerTabPath('p1', 'care', 'plugins'), '/p/p1?tab=care&view=plugins');
	assert.ok(EVENT_KINDS.includes('octoprint.updates'));
	assert.equal(EVENT_INFO['octoprint.updates'].label, 'OctoPrint updates available');
});

// --- against the mock OctoPrint -------------------------------------------------------------------------

let hookServer: Server;
const hooks: { event: string; title: string; message: string; url: string | null; data: Record<string, unknown> | null }[] = [];
const mocks: { close: () => Promise<void> }[] = [];

before(async () => {
	hookServer = createServer((req, res) => {
		let b = '';
		req.on('data', (d) => (b += d));
		req.on('end', () => {
			hooks.push(JSON.parse(b));
			res.end('ok');
		});
	});
	await new Promise<void>((r) => hookServer.listen(HOOK_PORT, '127.0.0.1', () => r()));
	const ch = notifySettings.createChannel({ type: 'webhook', name: 'hook', secrets: { url: `http://127.0.0.1:${HOOK_PORT}/` } });
	notifySettings.saveSettings({ publicUrl: 'https://octo.example', rules: [{ name: 'hook', printers: 'all', events: ['octoprint.updates'], channels: [ch.id] }] });
	srv.observePlugins();
});
after(async () => {
	for (const id of store.listPrinters().map((p) => p.id)) printers.forget(id);
	for (const m of mocks) await m.close();
	hookServer.closeAllConnections();
	await new Promise((r) => hookServer.close(r));
});

const PLUGINS = [
	{ key: 'pluginmanager', name: 'Plugin Manager', bundled: true, managable: false },
	{ key: 'softwareupdate', name: 'Software Update', bundled: true, managable: false },
	{ key: 'logging', name: 'Logging', bundled: true, managable: false },
	{ key: 'octolapse', name: 'Octolapse', version: '0.4.4', author: 'FormerLurker' },
	{ key: 'dashboard', name: 'Dashboard', version: '1.19.2', author: 'j7126' }
];
const REPO = [
	{ id: 'obico', title: 'Obico', author: 'The Obico team', installs: 40000 },
	{ id: 'oldplugin', title: 'Old Plugin', compatible: false }
];

async function mock(port: number, pluginManager: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	const m = await startMockOctoPrint({ port, apiKey: `key-${port}`, push: true, pluginManager: { plugins: PLUGINS, repository: REPO, installMs: 400, updateMs: 500, restartMs: 800, ...pluginManager }, ...extra });
	mocks.push(m);
	const p = store.createPrinter({ name: `Printer ${port}`, baseUrl: m.url, apiKey: `key-${port}`, verifyTls: true, webcamUrl: null, color: 'violet' });
	return { m, p, pm: m.pluginManager };
}

const settle = (id: string) => waitFor(() => (srv.opState(id)?.endedAt ? srv.opState(id) : null), 'the op to end');

test('list, legacy OctoPrint, a key that isn’t an admin’s', async () => {
	const { p, m } = await mock(4510, {});
	const list = await srv.listPlugins(p);
	assert.deepEqual(list.plugins.map((x) => x.key).sort(), PLUGINS.map((x) => x.key).sort());
	assert.equal(list.octoprint, '1.11.2');
	const { p: old } = await mock(4511, { legacy: true });
	assert.equal((await srv.listPlugins(old)).plugins.length, PLUGINS.length, 'OctoPrint < 1.6: the combined endpoint');
	assert.equal((await srv.repository(old)).plugins.length, REPO.length);
	const { p: user } = await mock(4512, { forbidden: true });
	await assert.rejects(srv.listPlugins(user), (e: { code?: string; message: string }) => e.code === srv.NOT_ADMIN && /isn’t an OctoPrint admin/.test(e.message));
	await assert.rejects(srv.checkUpdates(user, true), (e: { code?: string }) => e.code === srv.NOT_ADMIN);
	await assert.rejects(srv.togglePlugin(user, 'octolapse', 'disable'), (e: { code?: string }) => e.code === srv.NOT_ADMIN);
	// A wrong key isn't reported as "not an admin".
	const wrong = store.createPrinter({ name: 'Wrong key', baseUrl: m.url, apiKey: 'wrong-key-123', verifyTls: true, webcamUrl: null, color: 'violet' });
	await assert.rejects(srv.listPlugins(wrong), (e: { code?: string }) => e.code === 'HTTP_403');
});

test('enable/disable: OctoPrint’s result, and "restart needed" until OctoPrint restarts', async () => {
	const { p, pm } = await mock(4513, { restartNeeding: ['octolapse'] });
	let r = await srv.togglePlugin(p, 'dashboard', 'disable');
	assert.equal(r.needsRestart, false);
	assert.equal(r.plugin?.enabled, false);
	assert.equal(srv.restartNeeded(p.id, (await srv.listPlugins(p)).plugins), false);
	r = await srv.togglePlugin(p, 'octolapse', 'disable');
	assert.equal(r.needsRestart, true);
	const list = (await srv.listPlugins(p)).plugins;
	assert.equal(list.find((x) => x.key === 'octolapse')!.pendingDisable, true);
	assert.equal(srv.restartNeeded(p.id, list), true);
	assert.deepEqual(pm.calls.map((c: { command: string }) => c.command), ['disable', 'disable']);
	await assert.rejects(srv.togglePlugin(p, 'nope', 'enable'), /Unknown plugin/);
	// Restart: the pending change applies, the flag clears once OctoPrint is back.
	const op = await srv.restartOctoPrint(p, 'Ada');
	assert.equal(op.phase, 'restarting');
	const done = await settle(p.id);
	assert.equal(done!.phase, 'done', done!.message ?? '');
	assert.match(done!.message!, /OctoPrint 1\.11\.2 restarted/);
	assert.equal(pm.restarts, 1);
	const after = (await srv.listPlugins(p)).plugins;
	assert.equal(after.find((x) => x.key === 'octolapse')!.enabled, false);
	assert.equal(srv.restartNeeded(p.id, after), false);
});

test('restart without a restart command: a clear refusal', async () => {
	const { p, pm } = await mock(4514, { restartCommand: false });
	assert.equal(await srv.hasRestartCommand(p), false);
	await assert.rejects(srv.restartOctoPrint(p, null), (e: { code?: string; hint?: string }) => e.code === 'NO_RESTART_COMMAND' && /Settings → Server → Commands/.test(e.hint ?? ''));
	assert.equal(pm.restarts, 0);
	assert.equal(srv.opState(p.id), null);
});

test('install from the repository: live log lines over the push socket, then the result', async () => {
	const { p, pm } = await mock(4515, {});
	const repo = await srv.repository(p);
	const obico = repo.plugins.find((x) => x.id === 'obico')!;
	const op = await srv.installPlugin(p, { url: obico.archive!, label: obico.title, pluginId: obico.id, fromRepo: true }, 'Ada');
	assert.equal(op.phase, 'running');
	assert.equal(op.startedBy, 'Ada');
	await assert.rejects(srv.togglePlugin(p, 'dashboard', 'disable'), /Wait for the running install/);
	const done = (await settle(p.id))!;
	assert.equal(done.phase, 'done', done.message ?? '');
	assert.equal(done.message, 'Obico 1.0.0 installed');
	assert.equal(done.needsRestart, true);
	assert.ok(done.log.some((l) => /pip install/.test(l.line) && l.stream === 'call'), 'log lines from the push socket');
	assert.ok(done.log.some((l) => /Successfully installed/.test(l.line)));
	assert.deepEqual(pm.calls[0], { command: 'install', url: obico.archive, from_repo: true });
	assert.equal(srv.restartNeeded(p.id, null), true);
	// A failing archive: the op ends in error with OctoPrint's reason and pip's stderr.
	const bad = await srv.installPlugin(p, { url: 'https://example.com/OctoPrint-Fail/archive/main.zip', label: 'main.zip', fromRepo: false }, null);
	assert.equal(bad.kind, 'install');
	const failed = (await waitFor(() => (srv.opState(p.id)?.id === bad.id && srv.opState(p.id)?.endedAt ? srv.opState(p.id) : null), 'failed install'))!;
	assert.equal(failed.phase, 'error');
	assert.match(failed.message!, /Could not install plugin/);
	assert.ok(failed.log.some((l) => l.stream === 'stderr'));
});

test('install without push: the new plugin turning up in the list ends it', async () => {
	const { p } = await mock(4516, {}, { push: false });
	const op = await srv.installPlugin(p, { url: 'https://github.com/x/OctoPrint-Spoolhelper/archive/main.zip', label: 'main.zip', fromRepo: false }, null);
	const done = (await waitFor(() => (srv.opState(p.id)?.id === op.id && srv.opState(p.id)?.endedAt ? srv.opState(p.id) : null), 'install via polling'))!;
	assert.equal(done.phase, 'done', done.message ?? '');
	assert.match(done.message!, /Spoolhelper 1\.0\.0 installed/);
});

test('uninstall: done, restart needed', async () => {
	const { p, pm } = await mock(4517, {});
	const list = (await srv.listPlugins(p)).plugins;
	const op = await srv.uninstallPlugin(p, list.find((x) => x.key === 'dashboard')!, true, 'Ada');
	assert.equal(op.phase, 'done', op.message ?? '');
	assert.equal(op.needsRestart, true);
	assert.deepEqual(pm.calls.at(-1), { command: 'uninstall', plugin: 'dashboard', cleanup: true });
	assert.equal((await srv.listPlugins(p)).plugins.find((x) => x.key === 'dashboard')!.pendingUninstall, true);
	// Bundled ones: OctoPrint refuses (the route checks first, too).
	const r = await srv.uninstallPlugin(p, list.find((x) => x.key === 'logging')!, false, null).catch((e) => e);
	assert.match(String(r.message ?? r), /not managable/);
});

test('update OctoPrint and a plugin: progress, OctoPrint restarts and comes back with the new version', async () => {
	const updates = {
		octoprint: { available: '1.11.3', releaseNotes: 'https://github.com/OctoPrint/OctoPrint/releases/tag/1.11.3' },
		octolapse: { available: '0.4.5' }
	};
	const { p, pm, m } = await mock(4518, { updates });
	const check = await srv.checkUpdates(p, true);
	assert.equal(pm.forcedChecks, 1);
	assert.equal(check.status, 'updatePossible');
	assert.equal(check.octoprint?.current, '1.11.2');
	assert.equal(check.octoprint?.available, '1.11.3');
	assert.equal(check.octoprint?.releaseNotes, updates.octoprint.releaseNotes);
	assert.deepEqual(lib.availableUpdates(check).map((t) => t.key), ['octoprint', 'octolapse']);
	assert.equal(srv.updateCount(p.id), 2, 'cached for the Care badge');
	const op = await srv.startUpdate(p, ['octoprint', 'octolapse'], '2 updates', 'Ada');
	assert.equal(op.kind, 'update');
	await waitFor(() => srv.opState(p.id)?.phase === 'restarting', 'restarting');
	const done = (await settle(p.id))!;
	assert.equal(done.phase, 'done', done.message ?? '');
	assert.equal(done.newVersion, '1.11.3');
	assert.match(done.message!, /OctoPrint 1\.11\.3 is running/);
	assert.ok(done.log.some((l) => /Updating OctoPrint to 1\.11\.3/.test(l.line)));
	assert.ok(done.log.some((l) => /OctoPrint is back \(1\.11\.3\)/.test(l.line)));
	assert.deepEqual(pm.calls.at(-1), { update: ['octoprint', 'octolapse'] });
	assert.equal(m.state.version, '1.11.3');
	assert.equal(srv.updateCount(p.id), 0, 'the cache follows');
	assert.equal(srv.restartNeeded(p.id, null), false);
});

test('update without a restart command: done, restart needed', async () => {
	const { p } = await mock(4519, { updates: { dashboard: { available: '1.20.0' } }, restartCommand: false });
	await srv.startUpdate(p, ['dashboard'], 'Dashboard 1.20.0', null);
	const done = (await settle(p.id))!;
	assert.equal(done.phase, 'done', done.message ?? '');
	assert.match(done.message!, /restart OctoPrint/);
	assert.equal(done.needsRestart, true);
	assert.equal(srv.restartNeeded(p.id, null), true);
});

test('update notification: once per set of versions, again for a new one; job skips Klipper and failures', async () => {
	const { p, pm } = await mock(4521, { updates: { octoprint: { available: '1.11.3' }, octolapse: { available: '0.4.5' } } });
	const { p: broken } = await mock(4522, { forbidden: true });
	const before = hooks.length;
	await srv.checkAllUpdates();
	const hook = await waitFor(() => hooks.slice(before).find((h) => h.event === 'octoprint.updates' && h.title.includes(p.name)), 'octoprint.updates webhook');
	assert.equal(hook.title, `Updates available: ${p.name}`);
	assert.equal(hook.message, `${p.name}: OctoPrint 1.11.2 → 1.11.3 and 1 plugin update available.`);
	assert.equal(hook.url, `https://octo.example/p/${p.id}?tab=care&view=plugins`);
	assert.equal((hook.data?.updates as unknown[]).length, 2);
	assert.match(srv.cachedUpdates(broken.id)!.error!, /isn’t an OctoPrint admin/);
	// Same versions: no second notification.
	await srv.checkAllUpdates();
	await sleep(400);
	assert.equal(hooks.slice(before).filter((h) => h.title.includes(p.name)).length, 1);
	// A newer version: notified again.
	pm.updates.octoprint.available = '1.11.4';
	await srv.checkAllUpdates();
	await waitFor(() => hooks.slice(before).filter((h) => h.title.includes(p.name)).length === 2, 'second webhook');
	assert.match(hooks.at(-1)!.message, /1\.11\.4/);
});
