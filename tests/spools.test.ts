import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-spools-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-spools';
const store = await import('../src/lib/server/store.ts');
const hs = await import('../src/lib/server/history/store.ts');
const sm = await import('../src/lib/server/spools/spoolman.ts');
const asg = await import('../src/lib/server/spools/assignments.ts');
const usage = await import('../src/lib/server/spools/usage.ts');
const check = await import('../src/lib/server/spools/check.ts');
const costs = await import('../src/lib/server/costs.ts');
const notify = await import('../src/lib/server/notify/settings.ts');
const { afterPrint } = await import('../src/lib/server/spools/after-print.ts');
const { aggregate, toCsv } = await import('../src/lib/server/history/stats.ts');
const { adminOnlyApi, controlApi } = await import('../src/lib/server/access.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const lib = await import('../src/lib/spools.ts');
// @ts-expect-error plain JS helper shared with the e2e scripts
const { startMockSpoolman } = await import('../scripts/e2e/mock-spoolman.mjs');

// Ports from this feature's range: the mock Spoolman and a webhook receiver.
const SPOOLMAN_PORT = 3225;
const HOOK_PORT = 3226;

type Mock = Awaited<ReturnType<typeof startMockSpoolman>>;
let mock: Mock;
let hookServer: Server;
const hooks: { event: string; title: string; message: string }[] = [];

// Port 9 refuses connections: no OctoPrint behind these printers.
const printer = (name: string) => store.createPrinter({ name, baseUrl: 'http://127.0.0.1:9', apiKey: `key-for-${name}`, verifyTls: true, webcamUrl: null, color: 'violet' });
const mk4 = printer('MK4');
const idex = printer('IDEX');

before(async () => {
	mock = await startMockSpoolman({ port: SPOOLMAN_PORT, auth: 'Bearer s3cret' });
	hookServer = createServer((req, res) => {
		let b = '';
		req.on('data', (d) => (b += d));
		req.on('end', () => {
			hooks.push(JSON.parse(b));
			res.end('ok');
		});
	});
	await new Promise<void>((r) => hookServer.listen(HOOK_PORT, '127.0.0.1', () => r()));
	const hookChannel = notify.createChannel({ type: 'webhook', name: 'hook', secrets: { url: `http://127.0.0.1:${HOOK_PORT}/` } });
	notify.saveSettings({ publicUrl: null, rules: [{ name: 'hook', printers: 'all', events: ['spool.low', 'maintenance.due'], channels: [hookChannel.id] }] });
});

after(async () => {
	printers.forget(mk4.id);
	printers.forget(idex.id);
	await mock.close();
	hookServer.closeAllConnections();
	await new Promise((r) => hookServer.close(r));
});

const near = (a: number | null | undefined, b: number, tol: number, label = '') => assert.ok(a != null && Math.abs(a - b) <= tol, `${label} ${a} vs ${b} (±${tol})`);

// --- pure --------------------------------------------------------------------------------

test('filament geometry: 1.75 mm PLA is about 2.98 g per metre', () => {
	near(lib.gramsFromMm(1000, 1.24, 1.75), 2.982, 0.001);
	near(lib.mmFromGrams(lib.gramsFromMm(1234, 1.27, 2.85), 1.27, 2.85), 1234, 1e-6);
});

test('parseSpool folds Spoolman’s spool, filament and vendor together', async () => {
	const { demoInventory } = await import('../scripts/e2e/mock-spoolman.mjs');
	const inv = demoInventory();
	const f = inv.filaments[0];
	const raw = { id: 1, registered: 'x', filament: f, price: 29.99, initial_weight: 1000, used_weight: 312.4, remaining_weight: 687.6, remaining_length: 230_590, archived: false, location: 'Shelf A', extra: {} };
	const s = lib.parseSpool(raw)!;
	assert.equal(s.name, 'Galaxy Black');
	assert.equal(s.vendor, 'Prusament');
	assert.equal(s.material, 'PLA');
	assert.equal(s.color, '#1b1b1f');
	assert.equal(s.remainingWeight, 687.6);
	assert.equal(s.pricePerKg, 29.99);
	assert.equal(s.location, 'Shelf A');
	// No spool fields: remaining from the filament's net weight, length from density/diameter, price from the filament.
	const bare = lib.parseSpool({ id: 2, filament: { ...f, price: 25, weight: 750 }, used_weight: 150 })!;
	assert.equal(bare.remainingWeight, 600);
	near(bare.remainingLength, lib.mmFromGrams(600, 1.24, 1.75), 0.01);
	near(bare.pricePerKg, 33.33, 0.01);
	// Multi-colour filament, and junk.
	const multi = lib.parseSpool({ id: 3, filament: inv.filaments[4], used_weight: 0 })!;
	assert.deepEqual(multi.colors, ['#e63946', '#f4a261', '#2a9d8f', '#457b9d']);
	assert.equal(multi.color, '#e63946');
	assert.equal(lib.parseSpool({ name: 'no id' }), null);
	assert.equal(lib.parseSpool({ id: 4, filament: { color_hex: 'javascript:' } })!.color, null);
});

test('shortfalls: by length per tool, by the slicer’s weight when there is one tool', () => {
	const spool = (id: number, g: number) => lib.parseSpool({ id, filament: { name: `S${id}`, material: 'PLA', density: 1.24, diameter: 1.75, weight: 1000 }, used_weight: 1000 - g })!;
	const spools = new Map([
		[0, spool(1, 30)],
		[1, spool(2, 500)]
	]);
	// 30 g ≈ 10.06 m.
	assert.equal(lib.findShortfalls({ perTool: { 0: 9000 } }, spools).length, 0);
	const short = lib.findShortfalls({ perTool: { 0: 12_000, 1: 1000 } }, spools);
	assert.deepEqual(
		short.map((s) => s.tool),
		[0]
	);
	assert.match(lib.shortfallMessage(short, true), /^Tool 0: S1 \(PLA\) has 30 g \/ 10\.1 m left; this print needs about 36 g \/ 12\.0 m\. Start anyway\?$/);
	// One tool with the slicer's weight: 31 g needed, 30 left.
	assert.equal(lib.findShortfalls({ perTool: { 0: 9000 }, totalG: 31 }, spools).length, 1);
	// A tool without a spool, or an unknown amount, never blocks.
	assert.equal(lib.findShortfalls({ perTool: { 3: 1e9 } }, spools).length, 0);
});

test('computeCost: filament by spool or material price, electricity by time × draw', () => {
	const s = { ...lib.DEFAULT_COSTS, electricityPerKwh: 0.3 };
	// 10 m PLA ≈ 29.82 g × 20/kg = 0.596; 2 h × 150 W = 0.3 kWh × 0.3 = 0.09.
	const c = lib.computeCost({ tools: [{ mm: 10_000 }], durationS: 7200, powerW: 150 }, s);
	near(c.filamentG, 29.82, 0.01);
	near(c.costFilament, 0.5964, 0.0001);
	near(c.costEnergy, 0.09, 1e-9);
	assert.equal(c.material, 'PLA');
	assert.equal(c.source, 'settings');
	// A spool with a price wins (unless turned off); density from the spool.
	const spool = { material: 'PETG', density: 1.27, diameter: 1.75, pricePerKg: 40 };
	const c2 = lib.computeCost({ tools: [{ mm: 10_000, spool }], durationS: null, powerW: 150 }, s);
	assert.equal(c2.source, 'spool');
	near(c2.costFilament, (lib.gramsFromMm(10_000, 1.27, 1.75) / 1000) * 40, 1e-4);
	assert.equal(c2.costEnergy, null, 'no duration, no energy cost');
	const c3 = lib.computeCost({ tools: [{ mm: 10_000, spool }] , durationS: 60, powerW: null }, { ...s, useSpoolmanPrices: false });
	assert.equal(c3.source, 'settings');
	near(c3.costFilament, (lib.gramsFromMm(10_000, 1.27, 1.75) / 1000) * 22, 1e-4, 'PETG list price');
	assert.equal(c3.costEnergy, null, 'no power draw known');
	// Two tools add up.
	const c4 = lib.computeCost({ tools: [{ mm: 5000 }, { mm: 5000 }], durationS: 0, powerW: 100 }, s);
	near(c4.costFilament, c.costFilament!, 1e-4);
	assert.equal(lib.formatMoney(1.5, 'EUR').replace(/\s/g, '').includes('1.50') || lib.formatMoney(1.5, 'EUR').includes('1,50'), true);
	assert.equal(lib.formatMoney(null, 'EUR'), '—');
});

test('maintenance status thresholds and labels', () => {
	assert.equal(lib.maintenanceStatus(10, 100), 'ok');
	assert.equal(lib.maintenanceStatus(90, 100), 'due');
	assert.equal(lib.maintenanceStatus(100, 100), 'overdue');
	assert.equal(lib.usageLabel({ metric: 'hours', used: 12.34, interval: 200 }), '12 / 200 h');
	assert.equal(lib.usageLabel({ metric: 'filament', used: 1.234, interval: 5 }), '1.23 / 5 kg');
});

test('access: Spoolman and cost settings are admin-only, spools and maintenance changes need control', () => {
	assert.ok(adminOnlyApi('GET', '/api/settings/spoolman'));
	assert.ok(adminOnlyApi('PUT', '/api/settings/costs'));
	assert.ok(adminOnlyApi('POST', '/api/settings/costs/recalculate'));
	assert.ok(!adminOnlyApi('GET', '/api/spools'));
	assert.ok(!controlApi('GET', '/api/printers/x/spools'));
	assert.ok(controlApi('PUT', '/api/printers/x/spools'));
	assert.ok(controlApi('POST', '/api/printers/x/maintenance'));
	assert.ok(controlApi('POST', '/api/printers/x/maintenance/abc/done'));
	assert.ok(!controlApi('GET', '/api/printers/x/maintenance'));
});

// --- Spoolman client ------------------------------------------------------------------------

test('Spoolman settings: address normalised, auth value sealed, validation', () => {
	assert.equal(sm.normalizeSpoolmanUrl('http://spoolman.lan:7912/api/v1/'), 'http://spoolman.lan:7912');
	assert.equal(sm.normalizeSpoolmanUrl(' https://x.example/spoolman/ '), 'https://x.example/spoolman');
	assert.throws(() => sm.normalizeSpoolmanUrl('ftp://x'), /http/);
	assert.throws(() => sm.normalizeSpoolmanUrl('http://u:p@x'), /credentials/);
	assert.throws(() => sm.saveSpoolmanSettings({ url: 'http://x', authHeader: 'Bad Header' }), /header name/);
	const s = sm.saveSpoolmanSettings({ url: `http://127.0.0.1:${SPOOLMAN_PORT}/api/v1`, authHeader: 'Authorization', authValue: 'Bearer s3cret', lowThresholdG: 50 });
	assert.deepEqual(s, { url: `http://127.0.0.1:${SPOOLMAN_PORT}`, authHeader: 'Authorization', hasAuthValue: true, lowThresholdG: 50, progressive: true });
	const raw = JSON.stringify(store.getKv('spoolman:settings', {}));
	assert.ok(!raw.includes('s3cret'), 'the header value is sealed');
	// Saving again without a value keeps it.
	assert.equal(sm.saveSpoolmanSettings({ url: s.url, authHeader: 'Authorization', lowThresholdG: 50 }).hasAuthValue, true);
});

test('Spoolman client: lists spools with the auth header, reports use, explains refusals', async () => {
	const t = await sm.testSpoolman();
	assert.equal(t.version, '0.22.1');
	assert.equal(t.spools, 6, 'archived spools left out');
	assert.equal(mock.requests.at(-1).headers.authorization, 'Bearer s3cret');
	const before = (await sm.getSpool(6, { fresh: true }))!;
	assert.equal(before.remainingWeight, 1000);
	const after = (await sm.useSpool(6, 10_000))!;
	near(after.remainingWeight, 1000 - lib.gramsFromMm(10_000, 1.27, 1.75), 0.01, 'Spoolman converts length with the filament’s density');
	assert.deepEqual(mock.uses.at(-1), { id: 6, body: { use_length: 10_000 } });
	assert.equal(await sm.getSpool(999, { fresh: true }), null);
	// Wrong auth: a clear message.
	sm.saveSpoolmanSettings({ url: `http://127.0.0.1:${SPOOLMAN_PORT}`, authHeader: 'Authorization', authValue: 'Bearer nope', lowThresholdG: 50 });
	await assert.rejects(sm.listSpools({ fresh: true }), /refused.*auth header/);
	sm.saveSpoolmanSettings({ url: `http://127.0.0.1:${SPOOLMAN_PORT}`, authHeader: 'Authorization', authValue: 'Bearer s3cret', lowThresholdG: 50 });
	// Nobody there.
	sm.saveSpoolmanSettings({ url: 'http://127.0.0.1:9', authHeader: null, lowThresholdG: 50 });
	await assert.rejects(sm.listSpools({ fresh: true }), /Can’t reach Spoolman/);
	sm.saveSpoolmanSettings({ url: `http://127.0.0.1:${SPOOLMAN_PORT}`, authHeader: 'Authorization', authValue: 'Bearer s3cret', lowThresholdG: 50 });
});

test('assignments: one spool per tool, a spool on one tool at a time', async () => {
	asg.assignSpool(mk4.id, 0, 1, 'Ada');
	asg.assignSpool(idex.id, 0, 2, 'Ada');
	asg.assignSpool(idex.id, 1, 1, 'Ada'); // moves spool 1 from the MK4
	assert.deepEqual(asg.listAssignments(mk4.id), []);
	assert.deepEqual(
		asg.listAssignments(idex.id).map((a) => [a.tool, a.spoolId]),
		[
			[0, 2],
			[1, 1]
		]
	);
	asg.assignSpool(idex.id, 1, null, null);
	asg.assignSpool(mk4.id, 0, 1, 'Ada');
	const ps = await asg.printerSpools(mk4.id);
	assert.equal(ps.configured, true);
	assert.equal(ps.assignments[0].spool?.name, 'Galaxy Black');
	assert.equal(ps.tools, 1);
});

test('pre-print check: warns only when a spool won’t last, and never because Spoolman is down', async () => {
	assert.ok(check.wantsFilamentCheck(mk4.id));
	// Spool 1: 687.6 g ≈ 230 m.
	assert.equal(await check.filamentWarning(mk4.id, { perTool: { 0: 20_000 } }), null);
	const w = await check.filamentWarning(mk4.id, { perTool: { 0: 300_000 } });
	assert.match(w!, /^Galaxy Black \(PLA\) has 688 g/);
	assert.match((await check.filamentWarning(mk4.id, check.needFromMeta({ filamentMm: 1000, filamentG: 700 })))!, /needs about 700 g/);
	assert.deepEqual(check.perToolMm({ tool0: { length: 100, volume: 1 }, tool1: { length: null }, bogus: {} }), { 0: 100 });
	sm.saveSpoolmanSettings({ url: 'http://127.0.0.1:9', authHeader: null, lowThresholdG: 50 });
	sm.clearSpoolCache();
	assert.equal(await check.filamentWarning(mk4.id, { perTool: { 0: 300_000 } }), null);
	sm.saveSpoolmanSettings({ url: `http://127.0.0.1:${SPOOLMAN_PORT}`, authHeader: 'Authorization', authValue: 'Bearer s3cret', lowThresholdG: 50 });
	assert.ok(!check.wantsFilamentCheck(idex.id + 'x'));
});

const add = (o: Partial<Parameters<typeof hs.insertPrint>[0]>) =>
	hs.insertPrint({ printerId: mk4.id, printerName: 'MK4', file: 'x.gcode', path: 'x.gcode', origin: 'local', startedAt: new Date().toISOString(), result: 'success', ...o })!;

test('usage: progressive reports while printing, the rest at the end, exactly once', async () => {
	const usedBefore = mock.spool(1).used_weight;
	const n0 = mock.uses.length;
	const id = add({ file: 'benchy.gcode', path: 'benchy.gcode', result: 'printing', filamentMm: 4000 });
	// What the live snapshot says while it prints: 4 m planned, 60 % done.
	const model = printers.model(mk4.id)!;
	model.snapshot = {
		...model.snapshot,
		state: 'printing',
		job: { file: { name: 'benchy.gcode', path: 'benchy.gcode', display: 'benchy.gcode', origin: 'local', size: 1, date: null }, estimatedPrintTime: 3600, filament: { tool0: { length: 4000, volume: 9 } }, user: null },
		progress: { completion: 60, printTime: 600, printTimeLeft: 400, printTimeLeftOrigin: null, filepos: null }
	};
	await usage.trackUsage();
	assert.deepEqual(mock.uses.slice(n0), [{ id: 1, body: { use_length: 2400 } }], 'reported 60 % of 4 m');
	await usage.trackUsage();
	assert.equal(mock.uses.length, n0 + 1, 'nothing new to report');
	model.snapshot = { ...model.snapshot, progress: { ...model.snapshot.progress!, completion: 70 } };
	await usage.trackUsage();
	assert.equal(mock.uses.length, n0 + 1, 'less than a metre more: waits');
	// The end: success, all 4 m.
	hs.updatePrint(id, { result: 'success', endedAt: new Date().toISOString(), durationS: 1000, completion: 100, filamentMm: 4000 });
	const shares = await usage.finishUsage(hs.getPrint(id)!);
	assert.deepEqual(shares, [{ tool: 0, mm: 4000, spoolId: 1 }]);
	assert.deepEqual(mock.uses.slice(n0 + 1), [{ id: 1, body: { use_length: 1600 } }], 'the remaining 1.6 m');
	await usage.finishUsage(hs.getPrint(id)!);
	await usage.trackUsage();
	assert.equal(mock.uses.length, n0 + 2, 'never twice');
	near(mock.spool(1).used_weight - usedBefore, lib.gramsFromMm(4000, 1.24, 1.75), 0.01, 'Spoolman’s total');
	model.snapshot = { ...model.snapshot, state: 'operational', progress: null };
});

test('usage: a cancelled multi-tool print splits per tool; failed reports are retried', async () => {
	asg.assignSpool(idex.id, 0, 2, 'Ada');
	asg.assignSpool(idex.id, 1, 4, 'Ada');
	const model = printers.model(idex.id)!;
	model.snapshot = {
		...model.snapshot,
		job: { file: { name: 'duo.gcode', path: 'duo.gcode', display: 'duo.gcode', origin: 'local', size: 1, date: null }, estimatedPrintTime: 3600, filament: { tool0: { length: 3000, volume: 1 }, tool1: { length: 1000, volume: 1 } }, user: null },
		progress: null
	};
	const id = add({ printerId: idex.id, printerName: 'IDEX', file: 'duo.gcode', path: 'duo.gcode', result: 'cancelled', completion: 50, filamentMm: 2000, durationS: 600 });
	// Spoolman is down when it ends.
	sm.saveSpoolmanSettings({ url: 'http://127.0.0.1:9', authHeader: null, lowThresholdG: 50 });
	const shares = await usage.finishUsage(hs.getPrint(id)!);
	assert.deepEqual(shares, [
		{ tool: 0, mm: 1500, spoolId: 2 },
		{ tool: 1, mm: 500, spoolId: 4 }
	]);
	assert.ok(usage.usageRows(id).every((r) => r.reportedMm === 0 && r.lastError), 'pending, with the error');
	sm.saveSpoolmanSettings({ url: `http://127.0.0.1:${SPOOLMAN_PORT}`, authHeader: 'Authorization', authValue: 'Bearer s3cret', lowThresholdG: 50 });
	const n0 = mock.uses.length;
	await usage.trackUsage();
	assert.deepEqual(
		mock.uses.slice(n0).sort((a: { id: number }, b: { id: number }) => a.id - b.id),
		[
			{ id: 2, body: { use_length: 1500 } },
			{ id: 4, body: { use_length: 500 } }
		]
	);
	assert.ok(usage.usageRows(id).every((r) => r.reportedMm === r.targetMm && !r.lastError));
});

test('spool.low: notified once when a spool drops below the threshold, again after a refill', async () => {
	hooks.length = 0;
	// Spool 3 has 94.8 g left; threshold 100 g.
	sm.saveSpoolmanSettings({ url: `http://127.0.0.1:${SPOOLMAN_PORT}`, authHeader: 'Authorization', lowThresholdG: 100 });
	const s3 = (await sm.getSpool(3, { fresh: true }))!;
	assert.equal(await usage.checkLow(s3, mk4.id), true);
	assert.equal(await usage.checkLow(s3, mk4.id), false, 'once');
	assert.equal(hooks.length, 1);
	assert.equal(hooks[0].event, 'spool.low');
	assert.match(hooks[0].message, /PolyTerra Cotton White \(PLA\) on MK4 is down to 95 g/);
	assert.equal(await usage.checkLow({ ...s3, remainingWeight: 900 }, mk4.id), false, 'refilled');
	assert.equal(await usage.checkLow(s3, mk4.id), true, 'low again');
});

test('afterPrint: reports, costs the print from the spool’s price, and the stats/CSV carry it', async () => {
	costs.saveCostSettings({ ...lib.DEFAULT_COSTS, currency: 'EUR', electricityPerKwh: 0.4, defaultPowerW: 100, printerPowerW: { [mk4.id]: 150 } }, [mk4.id, idex.id]);
	const id = add({ file: 'cube.gcode', path: 'cube.gcode', result: 'success', completion: 100, filamentMm: 10_000, durationS: 3600 });
	await afterPrint(hs.getPrint(id)!);
	const r = hs.getPrint(id)!;
	// Spool 1: 29.99 per 1000 g; 10 m ≈ 29.82 g → 0.894; 1 h × 150 W × 0.4 = 0.06.
	near(r.filamentG, 29.82, 0.01);
	near(r.costFilament, 0.8943, 0.0005);
	near(r.costEnergy, 0.06, 1e-9);
	near(r.cost, 0.9543, 0.0005);
	assert.equal(r.material, 'PLA');
	const stats = aggregate([r, { ...r, printerId: 'other', cost: null }]);
	near(stats.cost, 0.9543, 0.0005);
	assert.equal(stats.costed, 1);
	const csv = toCsv([r]).split('\r\n');
	assert.match(csv[0], /,filament_g,material,cost_filament,cost_energy,cost_total$/);
	assert.match(csv[1], /,29\.8\d,PLA,0\.894\d*,0\.06,0\.954\d*$/);
});

test('cost backfill: entries without a cost get one; recalculating keeps spool prices', () => {
	const old = add({ file: 'old.gcode', path: 'old.gcode', startedAt: '2026-01-01T10:00:00.000Z', result: 'success', filamentMm: 3000, durationS: 1800, source: 'import' });
	const running = add({ file: 'run.gcode', path: 'run.gcode', result: 'printing', filamentMm: 3000 });
	assert.ok(costs.backfillCosts() >= 1);
	const o = hs.getPrint(old)!;
	near(o.costFilament, (lib.gramsFromMm(3000, 1.24, 1.75) / 1000) * 20, 1e-4, 'PLA list price');
	near(o.costEnergy, 0.5 * 0.15 * 0.4, 1e-9);
	assert.equal(hs.getPrint(running)!.cost, null, 'running prints wait for their end');
	// Prices change: recalculating updates list-priced entries, keeps spool-priced ones.
	const spoolPriced = hs.listPrints({ q: 'cube.gcode' })[0];
	costs.saveCostSettings({ ...costs.costSettings(), materials: lib.DEFAULT_MATERIALS.map((m) => (m.name === 'PLA' ? { ...m, pricePerKg: 40 } : m)) }, [mk4.id]);
	costs.backfillCosts({ all: true });
	near(hs.getPrint(old)!.costFilament, (lib.gramsFromMm(3000, 1.24, 1.75) / 1000) * 40, 1e-4);
	near(hs.getPrint(spoolPriced.id)!.costFilament, spoolPriced.costFilament!, 0.001, 'spool price kept');
	assert.throws(() => costs.saveCostSettings({ currency: 'euro' }, []), /three-letter/);
	assert.throws(() => costs.saveCostSettings({ currency: 'EUR', materials: [{ name: 'PLA', density: 9 }] }, []), /density/);
});
