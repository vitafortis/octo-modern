// The smart plug and the print queue together: auto power-on for a queued job with a
// confirmed-clear bed, and auto power-off held back while queued jobs wait for a bed clear.
// Local mocks only (127.0.0.1:3236 OctoPrint, :3238 plug).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain JS helper shared with the e2e script
import { startMockPlug } from '../scripts/e2e/mock-plugs.mjs';
// @ts-expect-error plain JS helper shared with the e2e script
import { startMockOctoPrint } from '../scripts/e2e/mock-octoprint.mjs';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-power-queue-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-power-queue';
const store = await import('../src/lib/server/store.ts');
const qs = await import('../src/lib/server/queue/store.ts');
const { dispatcher, wantPower } = await import('../src/lib/server/queue/dispatcher.ts');
const { power } = await import('../src/lib/server/power/service.ts');
const cfg = await import('../src/lib/server/power/config.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const { emptySnapshot } = await import('../src/lib/printer.ts');

const until = async (fn: () => boolean | Promise<boolean>, label: string, ms = 15_000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out: ${label}`);
};

test('wantPower: only unpowered printers with a clear bed and a fitting queued job', () => {
	const v = (o: Partial<Parameters<typeof wantPower>[1][number]>) => ({ id: 'a', tags: [], awaitingClear: false, held: false, state: 'disconnected' as const, hasApiKey: true, busy: false, tracking: false, ...o });
	const job = { id: 'j1', status: 'queued' as const, printerId: null, tags: [] };
	assert.deepEqual(wantPower(false, [v({})], [job]), [{ printerId: 'a', jobId: 'j1' }]);
	assert.deepEqual(wantPower(false, [v({ state: 'error' }), v({ id: 'b', state: 'offline' })], [job]).map((x) => x.printerId), ['a', 'b']);
	assert.deepEqual(wantPower(false, [v({ state: 'operational' })], [job]), [], 'already on: the dispatcher just starts it');
	assert.deepEqual(wantPower(false, [v({ awaitingClear: true })], [job]), [], 'bed not confirmed clear');
	assert.deepEqual(wantPower(false, [v({ held: true })], [job]), []);
	assert.deepEqual(wantPower(true, [v({})], [job]), [], 'queue paused');
	assert.deepEqual(wantPower(false, [v({})], [{ ...job, printerId: 'other' }]), [], 'job for another printer');
	assert.deepEqual(wantPower(false, [v({})], [{ ...job, status: 'done' as never }]), []);
	assert.deepEqual(wantPower(false, [v({})], [job], () => false), [], 'not allowed');
});

test('queue + plug: a queued job powers the printer on and starts; auto-off waits for the bed clear', async () => {
	const plug = await startMockPlug({ kind: 'tasmota', port: 3238, on: false });
	const op = await startMockOctoPrint({ port: 3236, apiKey: 'op-key-pq-1', powered: () => plug.state.on, printSeconds: 1, coolPerSecond: 5, connectMs: 100 });
	const printer = store.createPrinter({ name: 'Queue MK4', baseUrl: op.url, apiKey: 'op-key-pq-1', verifyTls: true, webcamUrl: null, color: 'violet' });
	power.connectDelays = [100, 100, 150, 200, 300, 500, 800];
	power.deps = { timeoutMs: 2_000 };
	after(async () => {
		qs.setPaused(true);
		power.keepOnChecks.delete(dispatcher.keepOnCheck);
		printers.forget(printer.id);
		await plug.close();
		await op.close();
	});
	cfg.savePlug(printer.id, cfg.parsePlugInput({ kind: 'tasmota', config: { url: plug.url }, settings: { autoOn: true, autoOff: { enabled: true, hotendC: 50, idleMinutes: 0 } } }));
	power.invalidate(printer.id);
	await printers.poll(printer.id);
	assert.equal(printers.snapshot(printer.id)?.state, 'disconnected');

	const job = qs.insertJob({ name: 'benchy.gcode', source: 'printer', sourceId: printer.id, path: 'benchy.gcode', size: 10, printerId: printer.id, tags: [], copies: 1, createdById: null, createdBy: 'test' });
	// The bed isn't confirmed clear yet: nothing is switched on.
	await dispatcher.tick();
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(plug.state.on, false, 'waits for the bed to be confirmed clear');

	// Confirmed: the dispatcher asks the plug to switch on, the printer connects, the job starts.
	qs.setAwaitingClear(printer.id, false);
	await dispatcher.tick();
	await until(() => plug.state.on, 'plug switched on for the queued job');
	await until(async () => {
		await dispatcher.tick();
		return op.state.state === 'Printing';
	}, 'the queued job printing');
	assert.equal(qs.getJob(job.id)?.status, 'printing');
	assert.ok(store.searchAudit({ printerId: printer.id, action: 'power.auto_on' }).some((e) => e.detail === 'queued job benchy.gcode'));

	await until(() => op.state.state === 'Operational', 'the print finished');

	// Auto power-off after the print is held while another queued job waits for the bed to be cleared.
	dispatcher.start();
	assert.ok(power.keepOnChecks.has(dispatcher.keepOnCheck));
	qs.insertJob({ name: 'second.gcode', source: 'printer', sourceId: printer.id, path: 'benchy.gcode', size: 10, printerId: printer.id, tags: [], copies: 1, createdById: null, createdBy: 'test' });
	qs.setAwaitingClear(printer.id, true);
	transitionDone(job.id);
	const snap = (state: 'printing' | 'operational', tool: number) => ({ ...emptySnapshot(printer.id), state, temps: { tool0: { actual: tool, target: 0 } } });
	power.observe(printer.id, snap('printing', 210));
	power.observe(printer.id, snap('operational', 200));
	assert.ok(power.info(printer.id)?.countdown, 'armed');
	power.observe(printer.id, snap('operational', 30));
	assert.equal(plug.state.on, true, 'not switched off');
	assert.match(power.info(printer.id)!.countdown!.heldBy!, /1 queued job waits for the bed to be cleared/);

	// With "stay on for the queue" off, it goes.
	qs.setPaused(true); // keep the dispatcher from powering it straight back on in this test
	cfg.savePlug(printer.id, { ...cfg.getPlug(printer.id)!, settings: { ...cfg.getPlug(printer.id)!.settings, autoOff: { enabled: true, hotendC: 50, idleMinutes: 0, waitForQueue: false } } });
	power.invalidate(printer.id);
	await power.read(printer.id);
	power.observe(printer.id, snap('printing', 210));
	power.observe(printer.id, snap('operational', 30)); // arms
	power.observe(printer.id, snap('operational', 30)); // due: fires
	await until(() => !plug.state.on, 'auto power-off without the queue hold').catch((e) => {
		console.log(JSON.stringify(store.searchAudit({ printerId: printer.id }).map((a) => [a.action, a.detail])), op.state.state, power.info(printer.id));
		throw e;
	});
});

function transitionDone(id: string) {
	qs.transition(id, ['printing', 'starting'], { status: 'done', done: 1, activePrinterId: null, activePath: null, finishedAt: new Date().toISOString() });
}
