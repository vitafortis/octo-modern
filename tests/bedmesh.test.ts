import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-bedmesh-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-bedmesh';
const lib = await import('../src/lib/bedmesh.ts');
const store = await import('../src/lib/server/store.ts');
const bm = await import('../src/lib/server/bedmesh.ts');
const notifySettings = await import('../src/lib/server/notify/settings.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
// @ts-expect-error: plain JS mock
const { startMockOctoPrint, demoMesh } = await import('../scripts/e2e/mock-octoprint.mjs');

// Ports 5420–5429 (this feature's range is 5400–5499).
const HOOK_PORT = 5420;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | Promise<T>, label: string, ms = 10_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out: ${label}`);
		await sleep(50);
	}
}

// --- parsing -----------------------------------------------------------------------

test('toZ: numbers and numeric strings; garbage, NaN and absurd values are missing', () => {
	assert.equal(lib.toZ(0.12), 0.12);
	assert.equal(lib.toZ(' -0.045 '), -0.045);
	assert.equal(lib.toZ('+.5'), 0.5);
	assert.equal(lib.toZ('1e-2'), 0.01);
	for (const bad of ['nan', 'NaN', '', '  ', 'abc', '0.1mm', null, undefined, {}, [], NaN, Infinity, 51, '-99', true]) assert.equal(lib.toZ(bad), null, String(bad));
});

test('parseGrid: the shapes the plugin (and older versions, other firmware) store', () => {
	// Strings, as the plugin keeps them.
	assert.deepEqual(lib.parseGrid([['0.1', '-0.2'], ['0.3', '0.4']]), [[0.1, -0.2], [0.3, 0.4]]);
	// Numbers.
	assert.deepEqual(lib.parseGrid([[1, 2, 3]]), [[1, 2, 3]]);
	// A JSON string.
	assert.deepEqual(lib.parseGrid('[["0.01","0.02"],["0.03","0.04"]]'), [[0.01, 0.02], [0.03, 0.04]]);
	// Rows as whitespace / comma separated text (firmware output pasted as lines).
	assert.deepEqual(lib.parseGrid(['+0.010 -0.020  0.030', '0.1,0.2,0.3']), [[0.01, -0.02, 0.03], [0.1, 0.2, 0.3]]);
	assert.deepEqual(lib.parseGrid('0.1 0.2\n0.3 0.4'), [[0.1, 0.2], [0.3, 0.4]]);
	// Ragged rows are padded; non-numeric cells are missing.
	assert.deepEqual(lib.parseGrid([['0.1', 'nan', '0.3'], ['0.4']]), [[0.1, null, 0.3], [0.4, null, null]]);
	// Leading/trailing rows without a number are dropped; inner ones kept.
	assert.deepEqual(lib.parseGrid([[], ['x', null], ['0.1', '0.2'], ['nan', 'nan'], ['0.5', '0.6'], []]), [[0.1, 0.2], [null, null], [0.5, 0.6]]);
	// A flat list of numbers is one row.
	assert.deepEqual(lib.parseGrid([0.1, '0.2', 0.3]), [[0.1, 0.2, 0.3]]);
	// Nothing usable.
	for (const bad of [null, undefined, '', '[]', [], [[]], [['nan', '']], 'not json', 42, { mesh: [] }, [[{}], [null]]]) assert.equal(lib.parseGrid(bad), null, JSON.stringify(bad));
	// Capped size.
	const big = Array.from({ length: 150 }, () => Array.from({ length: 150 }, () => '0.1'));
	const g = lib.parseGrid(big)!;
	assert.equal(g.length, lib.MAX_GRID);
	assert.equal(g[0].length, lib.MAX_GRID);
});

test('parseMesh: axes from the stored coordinates, else from the bed size, else indices; circular beds centred', () => {
	const z = [['0', '0.1', '0.2'], ['0.1', '0.2', '0.3']];
	assert.deepEqual(lib.parseMesh({ mesh: z, xs: [10, 120, 230], ys: ['10', '200'] })!.xs, [10, 120, 230]);
	assert.deepEqual(lib.parseMesh({ mesh: z, xs: [10, 120, 230], ys: ['10', '200'] })!.ys, [10, 200]);
	// Wrong length or non-numeric: even spacing from the bed (plugin message) or 0…n−1.
	assert.deepEqual(lib.parseMesh({ mesh: z, xs: [1, 2], bed: { x_min: 0, x_max: 200, y_min: 0, y_max: 100 } })!.xs, [0, 100, 200]);
	assert.deepEqual(lib.parseMesh({ mesh: z, xs: [1, 'a', 3] })!.xs, [0, 1, 2]);
	assert.deepEqual(lib.parseMesh({ mesh: z })!.ys, [0, 1]);
	const delta = lib.parseMesh({ mesh: z, bed: { type: 'circular', x_min: 0, x_max: 200, y_min: 0, y_max: 200 } })!;
	assert.deepEqual(delta.xs, [-100, 0, 100]);
	assert.deepEqual(delta.ys, [-100, 100]);
	assert.equal(lib.parseMesh({ mesh: 'garbage' }), null);
});

test('parsePluginSettings: not installed, set up, not set up', () => {
	assert.equal(lib.parsePluginSettings({}).installed, false);
	assert.equal(lib.parsePluginSettings(undefined).installed, false);
	assert.equal(lib.parsePluginSettings({ bedlevelvisualizer: null }).installed, false);
	const p = lib.parsePluginSettings({
		bedlevelvisualizer: { command: 'G28\r\n  G29 T  \n\n', stored_mesh: [['0.1', '0.2'], ['0.3', '0.4']], stored_mesh_x: [10, 200], stored_mesh_y: [10, 200], mesh_timestamp: '11/10/2026, 09:12:00', save_mesh: false, timeout: '600' }
	});
	assert.equal(p.installed, true);
	assert.deepEqual(p.commands, ['G28', 'G29 T']);
	assert.equal(p.saveMesh, false);
	assert.equal(p.timeoutS, 600);
	assert.deepEqual(p.stored!.xs, [10, 200]);
	assert.equal(p.storedTimestamp, '11/10/2026, 09:12:00');
	const empty = lib.parsePluginSettings({ bedlevelvisualizer: { command: '', stored_mesh: [] } });
	assert.equal(empty.installed, true);
	assert.deepEqual(empty.commands, []);
	assert.equal(empty.stored, null);
	assert.equal(empty.saveMesh, true);
	assert.equal(empty.timeoutS, 1800);
});

test('parsePluginMessage and the G-code of a probe run', () => {
	const m = lib.parsePluginMessage({ mesh: [['0.1', '0.2'], ['0.3', 'nan']], bed: { type: 'rectangular', x_min: 0, x_max: 100, y_min: 0, y_max: 50, z_max: 3 } });
	assert.equal(m?.kind, 'mesh');
	if (m?.kind === 'mesh') {
		assert.deepEqual(m.mesh.z, [[0.1, 0.2], [0.3, null]]);
		assert.deepEqual(m.mesh.xs, [0, 100]);
		assert.equal(m.zMax, 3);
	}
	assert.equal(lib.parsePluginMessage({ mesh: [] })?.kind, 'error');
	assert.deepEqual(lib.parsePluginMessage({ processing: true }), { kind: 'processing' });
	assert.deepEqual(lib.parsePluginMessage({ error: 'Home XYZ first' }), { kind: 'error', message: 'Home XYZ first' });
	assert.deepEqual(lib.parsePluginMessage({ timeout_override: 300 }), { kind: 'timeout', seconds: 300 });
	assert.deepEqual(lib.parsePluginMessage({ BLV: 'x' }), { kind: 'other' });
	assert.equal(lib.parsePluginMessage(null), null);
	assert.deepEqual(lib.updateCommands(['G28', '', '@BEDLEVELVISUALIZER', 'G29 T']), ['@BEDLEVELVISUALIZER', 'G28', 'G29 T']);
});

// --- stats, diff, drift -------------------------------------------------------------------

const mesh = (z: (number | null)[][], xs?: number[], ys?: number[]) => ({ z, xs: xs ?? z[0].map((_, i) => i * 10), ys: ys ?? z.map((_, i) => i * 10) });

test('meshStats: range, where, mean, flatness; missing points skipped', () => {
	const s = lib.meshStats(mesh([[0.1, -0.2, null], [0.05, 0.3, 0]], [10, 20, 30], [5, 15]))!;
	assert.equal(s.min, -0.2);
	assert.equal(s.max, 0.3);
	assert.deepEqual([s.minAt.x, s.minAt.y], [20, 5]);
	assert.deepEqual([s.maxAt.x, s.maxAt.y], [20, 15]);
	assert.equal(s.flatness, 0.5);
	assert.equal(s.points, 5);
	assert.equal(s.missing, 1);
	assert.equal(s.mean, 0.05);
	assert.equal(lib.meshStats(mesh([[null]])), null);
});

test('diffMesh: same grid point by point; a different grid is interpolated over the bed', () => {
	const a = mesh([[0, 0.1], [0.2, 0.3]]);
	const b = mesh([[0.05, 0.1], [0.1, null]]);
	assert.deepEqual(lib.diffMesh(a, b).z, [[0.05, 0], [-0.1, null]]);
	assert.equal(lib.maxAbs(lib.diffMesh(a, b)), 0.1);
	// 2×2 vs 3×3 over the same bed: the centre of a plane is its average.
	const plane2 = mesh([[0, 0.2], [0.2, 0.4]], [0, 200], [0, 200]);
	const plane3 = mesh([[0, 0.1, 0.2], [0.1, 0.2, 0.3], [0.2, 0.3, 0.4]], [0, 100, 200], [0, 100, 200]);
	const d = lib.diffMesh(plane2, plane3);
	assert.equal(d.z.length, 3);
	assert.ok(d.z.flat().every((v) => v !== null && Math.abs(v) < 1e-9), JSON.stringify(d.z));
	// A missing point in the earlier mesh is skipped when interpolating, and missing where exact.
	assert.equal(lib.sampleAt(mesh([[null, 1], [1, 1]]), 0, 0), null);
	assert.equal(lib.sampleAt(mesh([[null, 1], [1, 1]]), 0.5, 0.5), 1);
});

test('checkDrift and parseDriftSettings', () => {
	const ref = mesh([[0, 0], [0, 0]]);
	const now = mesh([[0, 0.12], [-0.25, 0.05]]);
	const c = lib.checkDrift(now, ref, { maxFlatness: 0.3, maxChange: 0.1 })!;
	assert.equal(c.flatness, 0.37);
	assert.equal(c.change, 0.25);
	assert.equal(c.breaches.length, 2);
	assert.match(c.breaches[0], /Flatness 0.370 mm is over the 0.300 mm limit/);
	assert.match(c.breaches[1], /moved 0.250 mm/);
	assert.deepEqual(lib.checkDrift(now, null, { maxFlatness: 1, maxChange: 0.1 })!.breaches, [], 'no reference: no change check');
	assert.deepEqual(lib.checkDrift(now, ref, { maxFlatness: null, maxChange: null })!.breaches, []);

	assert.deepEqual(lib.parseDriftSettings({ enabled: true, maxFlatness: '0.25', maxChange: '' }), { enabled: true, maxFlatness: 0.25, maxChange: null, referenceId: null });
	assert.throws(() => lib.parseDriftSettings({ maxFlatness: -1 }), /above 0/);
	assert.throws(() => lib.parseDriftSettings({ maxChange: 'x' }), /change limit/);
	assert.throws(() => lib.parseDriftSettings({ enabled: true, maxFlatness: null, maxChange: null }), /Set a flatness or a change limit/);
	assert.throws(() => lib.parseDriftSettings({ referenceId: 1.5 }), /referenceId/);
	assert.equal(lib.parseDriftSettings({ referenceId: 7 }).referenceId, 7);
});

test('colour scale: oklch tokens, diverging ends, readable ink', () => {
	assert.deepEqual(lib.parseOklch('oklch(56% 0.15 250)'), [0.56, 0.15, 250]);
	assert.deepEqual(lib.parseOklch(' oklch(0.5 0.1 20) '), [0.5, 0.1, 20]);
	assert.equal(lib.parseOklch('#fff'), null);
	const stops = { low: [0.5, 0.15, 250] as [number, number, number], mid: [0.97, 0.01, 292] as [number, number, number], high: [0.6, 0.18, 38] as [number, number, number] };
	assert.equal(lib.divergingColor(-1, 0, 1, stops), 'oklch(50.0% 0.150 250.0)');
	assert.equal(lib.divergingColor(5, 0, 1, stops), 'oklch(60.0% 0.180 38.0)', 'clamped');
	assert.equal(lib.divergingColor(0, 0, 1, stops), 'oklch(97.0% 0.010 292.0)');
	// The hue goes the short way round (292 → 38 passes 360).
	const h = lib.parseOklch(lib.divergingColor(0.5, 0, 1, stops))![2];
	assert.ok(h > 292 || h < 38, `hue ${h}`);
	assert.match(lib.inkFor('oklch(97% 0.01 292)'), /20%/);
	assert.match(lib.inkFor('oklch(40% 0.1 250)'), /98%/);
	assert.equal(lib.fmtZ(-0.0451), '−0.045');
	assert.equal(lib.fmtZ(0.1), '+0.100');
	assert.equal(lib.fmtZ(-0.0001), '0.000');
	assert.equal(lib.fmtZ(null), '—');
});

// --- storage, drift alerts ---------------------------------------------------------------------

let hookServer: Server;
const hooks: { event: string; title: string; message: string; url: string | null; data: Record<string, unknown> | null }[] = [];
let mocks: { close: () => Promise<void> }[] = [];

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
	notifySettings.saveSettings({ publicUrl: 'https://octo.example', rules: [{ name: 'hook', printers: 'all', events: ['bed.drift'], channels: [ch.id] }] });
});
after(async () => {
	for (const id of store.listPrinters().map((p) => p.id)) printers.forget(id);
	for (const m of mocks) await m.close();
	hookServer.closeAllConnections();
	await new Promise((r) => hookServer.close(r));
});

const newPrinter = (name: string, baseUrl = 'http://127.0.0.1:9', apiKey = 'key-for-printer') => store.createPrinter({ name, baseUrl, apiKey, verifyTls: true, webcamUrl: null, color: 'violet' });

test('storage: a mesh is stored once, seen again updates last seen; history newest first', () => {
	const p = newPrinter('Prusa');
	const m1 = mesh([[0, 0.1], [0.05, 0.02]]);
	const t0 = new Date('2026-10-01T10:00:00Z');
	const r1 = bm.ingest(p.id, m1, 'octoprint', { now: t0, pluginTimestamp: '01/10/2026' })!;
	assert.equal(r1.isNew, true);
	assert.equal(r1.snapshot.flatness, 0.1);
	assert.equal(r1.snapshot.change, null, 'the first mesh has no reference to compare with');
	const again = bm.ingest(p.id, { ...m1, z: m1.z.map((r) => r.map((v) => (v === null ? v : v + 1e-7))) }, 'octoprint', { now: new Date('2026-10-02T10:00:00Z') })!;
	assert.equal(again.isNew, false, 'tiny float noise is the same mesh');
	assert.equal(again.snapshot.lastSeenAt, '2026-10-02T10:00:00.000Z');
	assert.equal(again.snapshot.createdAt, t0.toISOString());
	const r2 = bm.ingest(p.id, mesh([[0, 0.2], [0.05, 0.02]]), 'push', { now: new Date('2026-10-03T10:00:00Z') })!;
	assert.equal(r2.isNew, true);
	assert.equal(r2.snapshot.change, 0.1);
	// OctoPrint still reporting the older mesh (writing back failed): not stored again.
	const stale = bm.ingest(p.id, m1, 'octoprint', { now: new Date('2026-10-04T10:00:00Z') })!;
	assert.equal(stale.isNew, false);
	assert.equal(stale.snapshot.id, r1.snapshot.id);
	// A live mesh equal to an older one (not the latest) is a new event, though.
	assert.equal(bm.ingest(p.id, m1, 'push')!.isNew, true);
	const list = bm.listMeshes(p.id);
	assert.equal(list.length, 3);
	assert.ok(list[0].id > list[1].id);
	assert.equal(bm.latestMesh(p.id)!.id, list[0].id);
	assert.deepEqual(bm.getMesh(r1.snapshot.id)!.mesh.z, m1.z);
	assert.equal(bm.ingest(p.id, mesh([[null]]), 'push'), null, 'nothing probed: nothing stored');
	assert.equal(bm.ingest('nope', m1, 'push'), null, 'unknown printer');
	// Deleting the printer deletes its meshes.
	store.deletePrinter(p.id);
	assert.equal(bm.listMeshes(p.id).length, 0);
});

test('storage: pruned to the newest meshes, keeping the oldest (default reference) and the chosen reference', () => {
	const p = newPrinter('Ender');
	const ids: number[] = [];
	for (let i = 0; i < bm.KEEP_PER_PRINTER + 5; i++) {
		ids.push(bm.ingest(p.id, mesh([[0, i / 1000]]), 'push', { notify: false })!.snapshot.id);
		if (i === 2) bm.saveDriftSettings(p.id, { ...bm.driftSettings(p.id), referenceId: ids[2] });
	}
	const kept = bm.listMeshes(p.id, 1000).map((m) => m.id);
	assert.equal(kept.length, bm.KEEP_PER_PRINTER);
	assert.ok(kept.includes(ids[0]), 'oldest kept');
	assert.ok(kept.includes(ids[2]), 'reference kept');
	assert.ok(!kept.includes(ids[3]));
	assert.ok(kept.includes(ids.at(-1)!));
	assert.equal(bm.referenceMesh(p.id)!.id, ids[2]);
	bm.saveDriftSettings(p.id, { ...bm.driftSettings(p.id), referenceId: null });
	assert.equal(bm.referenceMesh(p.id)!.id, ids[0]);
	store.deletePrinter(p.id);
});

test('drift alert: a new mesh beyond the limits sends bed.drift once, with the facts', async () => {
	const p = newPrinter('Voron');
	bm.saveDriftSettings(p.id, { enabled: true, maxFlatness: 0.3, maxChange: 0.1, referenceId: null });
	bm.ingest(p.id, mesh([[0, 0.05], [0.02, 0.04]]), 'octoprint');
	bm.ingest(p.id, mesh([[0, 0.08], [0.02, 0.04]]), 'push'); // fine
	await sleep(300);
	assert.equal(hooks.length, 0);
	const bad = bm.ingest(p.id, mesh([[0, 0.25], [-0.1, 0.04]]), 'update')!;
	assert.equal(bad.snapshot.drift, true);
	assert.equal(bad.snapshot.change, 0.2);
	const hook = await waitFor(() => hooks.find((h) => h.event === 'bed.drift'), 'bed.drift webhook');
	assert.match(hook.title, /Bed mesh drift: Voron/);
	assert.match(hook.message, /Flatness 0\.350 mm is over the 0\.300 mm limit; A point moved 0\.200 mm/);
	assert.equal(hook.url, `https://octo.example/p/${p.id}?tab=care&view=bed`);
	assert.equal(hook.data?.meshId, bad.snapshot.id);
	// Seen again: no second alert.
	bm.ingest(p.id, bad.snapshot.mesh, 'octoprint');
	// Alerts off: flagged, not sent.
	bm.saveDriftSettings(p.id, { ...bm.driftSettings(p.id), enabled: false });
	assert.equal(bm.ingest(p.id, mesh([[0, 0.5], [0, 0]]), 'push')!.snapshot.drift, true);
	await sleep(400);
	assert.equal(hooks.filter((h) => h.event === 'bed.drift').length, 1);
	store.deletePrinter(p.id);
});

// --- against the mock OctoPrint with the plugin ---------------------------------------------------

test('detect the plugin: installed with its stored mesh, not installed, unreachable', async () => {
	const withPlugin = await startMockOctoPrint({ port: 5421, apiKey: 'blv-key', bedVisualizer: { mesh: demoMesh(5), x: [10, 65, 120, 175, 230], y: [10, 57, 105, 152, 200], timestamp: '01/10/2026, 08:00:00' } });
	const without = await startMockOctoPrint({ port: 5422, apiKey: 'plain-key' });
	mocks.push(withPlugin, without);
	const a = newPrinter('With plugin', withPlugin.url, 'blv-key');
	const b = newPrinter('Without', without.url, 'plain-key');
	const c = newPrinter('Unreachable', 'http://127.0.0.1:5429', 'nope-key');
	const info = await bm.detectPlugin(a.id);
	assert.equal(info.installed, true);
	assert.deepEqual(info.commands, ['G28', 'G29 T']);
	assert.equal(bm.cachedPlugin(a.id)!.installed, true);
	const latest = bm.latestMesh(a.id)!;
	assert.equal(latest.source, 'octoprint');
	assert.equal(latest.pluginTimestamp, '01/10/2026, 08:00:00');
	assert.deepEqual(latest.mesh.xs, [10, 65, 120, 175, 230]);
	assert.equal((await bm.detectPlugin(b.id)).installed, false);
	assert.equal(await bm.pluginInstalled(b.id), false);
	const down = await bm.detectPlugin(c.id);
	assert.equal(down.installed, false);
	assert.ok(down.error);
	assert.equal(bm.cachedPlugin(c.id), null, 'a failure is not cached as "not installed"');
	// A mesh probed from OctoPrint's own UI shows up at the next check.
	await fetch(`${withPlugin.url}/__mock/bedmesh`, { method: 'POST', body: JSON.stringify({ mesh: demoMesh(5, { tilt: 0.1 }) }) });
	await bm.syncAll();
	assert.notEqual(bm.latestMesh(a.id)!.id, latest.id);
	for (const p of [a, b, c]) store.deletePrinter(p.id);
});

test('update over push: at-command + G-code, progress, the mesh stored and written back to the plugin', async () => {
	const op = await startMockOctoPrint({ port: 5423, apiKey: 'push-key', push: true, connectMs: 50, bedVisualizer: { delayMs: 400, nextMesh: () => demoMesh(7, { bow: 0.12 }) } });
	mocks.push(op);
	await fetch(`${op.url}/api/connection`, { method: 'POST', headers: { 'x-api-key': 'push-key', 'content-type': 'application/json' }, body: JSON.stringify({ command: 'connect' }) });
	await waitFor(() => op.state.state === 'Operational', 'mock printer connected');
	const p = newPrinter('Push', op.url, 'push-key');
	bm.observePlugin();
	const info = await bm.detectPlugin(p.id);
	const state = await bm.startUpdate(p.id, info, 'Otto');
	assert.equal(state.startedBy, 'Otto');
	assert.ok(bm.updateRunning(p.id));
	assert.deepEqual(op.state.commands, ['@BEDLEVELVISUALIZER', 'G28', 'G29 T']);
	assert.ok(op.state.pushClients >= 1 || (await waitFor(() => op.state.pushClients >= 1, 'push socket opened')), 'the update keeps a push connection open');
	const done = await waitFor(() => (bm.updateState(p.id)?.endedAt ? bm.updateState(p.id) : null), 'update finished');
	assert.equal(done!.phase, 'done', done!.message ?? '');
	const latest = bm.latestMesh(p.id)!;
	assert.equal(done!.meshId, latest.id);
	assert.equal(latest.source, 'update');
	assert.equal(latest.rows, 7);
	assert.deepEqual(latest.mesh.xs.slice(0, 2), [10, 48.33]);
	// Written back like the plugin's UI does.
	const write = await waitFor(() => op.state.settingsWrites.at(-1), 'settings written back');
	assert.equal(write.plugins.bedlevelvisualizer.stored_mesh.length, 7);
	assert.equal(typeof write.plugins.bedlevelvisualizer.stored_mesh[0][0], 'string');
	// The next check finds the same mesh in OctoPrint: nothing new.
	await bm.detectPlugin(p.id);
	assert.equal(bm.listMeshes(p.id).length, 1);
	// A plugin error ends the next run.
	await fetch(`${op.url}/__mock/bedmesh`, { method: 'POST', body: JSON.stringify({ fail: 'Home XYZ first' }) });
	await bm.startUpdate(p.id, info, 'Otto');
	const failed = await waitFor(() => (bm.updateState(p.id)?.endedAt && bm.updateState(p.id)!.phase !== 'done' ? bm.updateState(p.id) : null), 'update failed');
	assert.equal(failed!.phase, 'error');
	assert.equal(failed!.message, 'Home XYZ first');
	printers.forget(p.id);
	store.deletePrinter(p.id);
});

test('update without push: waits for the plugin’s stored mesh to change', async () => {
	const op = await startMockOctoPrint({ port: 5424, apiKey: 'poll-key', connectMs: 50, bedVisualizer: { delayMs: 200, uiSaves: true, mesh: demoMesh(5), nextMesh: () => demoMesh(5, { tilt: 0.2 }) } });
	mocks.push(op);
	await fetch(`${op.url}/api/connection`, { method: 'POST', headers: { 'x-api-key': 'poll-key', 'content-type': 'application/json' }, body: JSON.stringify({ command: 'connect' }) });
	await waitFor(() => op.state.state === 'Operational', 'mock printer connected');
	const p = newPrinter('Poll', op.url, 'poll-key');
	const info = await bm.detectPlugin(p.id);
	const before = bm.latestMesh(p.id)!.id;
	await bm.startUpdate(p.id, info, null, { pollMs: 150 });
	const done = await waitFor(() => (bm.updateState(p.id)?.endedAt ? bm.updateState(p.id) : null), 'update finished');
	assert.equal(done!.phase, 'done');
	assert.notEqual(bm.latestMesh(p.id)!.id, before);
	assert.equal(bm.latestMesh(p.id)!.source, 'update');
	printers.forget(p.id);
	store.deletePrinter(p.id);
});
