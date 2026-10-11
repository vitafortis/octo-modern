// Auto power-off countdowns survive a restart: saved when armed, cleared when cancelled or
// done, resumed by a fresh PowerService (what a restarted process is), with the conditions
// checked again before anything is switched off. Local mocks only (127.0.0.1:5110 plug,
// :5111 OctoPrint).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain JS helper shared with the e2e script
import { startMockPlug } from '../scripts/e2e/mock-plugs.mjs';
// @ts-expect-error plain JS helper shared with the e2e script
import { startMockOctoPrint } from '../scripts/e2e/mock-octoprint.mjs';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-power-resume-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-power-resume';
const store = await import('../src/lib/server/store.ts');
const cfg = await import('../src/lib/server/power/config.ts');
const pending = await import('../src/lib/server/power/pending.ts');
const { AutoOff } = await import('../src/lib/server/power/autooff.ts');
const { PowerService } = await import('../src/lib/server/power/service.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const { emptySnapshot } = await import('../src/lib/printer.ts');

const M = 60_000;
const PLUG_PORT = 5110;
const OP_PORT = 5111;

const until = async (fn: () => boolean | Promise<boolean>, label: string, ms = 10_000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out: ${label}`);
};

test('auto-off: a restored countdown waits for a known state, then fires, waits to cool, or cancels', () => {
	const s = { enabled: true, hotendC: 50, idleMinutes: 10, waitForQueue: true };
	const o = (a: InstanceType<typeof AutoOff>, now: number, state: Parameters<InstanceType<typeof AutoOff>['observe']>[0]['state'], hotendC: number | null, plugOn: boolean | null = true) => a.observe({ now, state, hotendC, plugOn }, s);

	const a = new AutoOff();
	a.restore(0);
	assert.equal(a.resumed, true);
	assert.equal(a.countdown(s)!.offAt, 10 * M, 'the countdown shows from when it was armed');
	assert.equal(o(a, 30 * M, 'unknown', null), null, 'deadline passed, but nothing known about the printer yet');
	assert.equal(o(a, 30 * M, 'offline', null), null, 'OctoPrint unreachable: still waiting');
	assert.equal(a.armedAt, 0);
	assert.deepEqual(o(a, 30 * M, 'operational', 30), { type: 'fire' }, 'idle and cool: due');

	const busy = new AutoOff();
	busy.restore(0);
	assert.deepEqual(o(busy, 30 * M, 'printing', 210), { type: 'cancelled', reason: 'A new print started' }, 'printing now: never off');
	assert.equal(busy.armedAt, null);

	const hot = new AutoOff();
	hot.restore(0);
	assert.equal(o(hot, 30 * M, 'operational', 120), null, 'idle long enough but hot: waits');
	assert.equal(hot.countdown(s)!.cooling, true);
	assert.equal(hot.resumed, false, 'seen since');
	assert.deepEqual(o(hot, 31 * M, 'operational', 45), { type: 'fire' });

	const off = new AutoOff();
	off.restore(0);
	assert.deepEqual(o(off, 30 * M, 'disconnected', null, false), { type: 'cancelled', reason: 'The plug is off' });
});

test('service: the countdown is saved, resumed after a restart, re-checked when overdue, never fires mid-print', async () => {
	const plug = await startMockPlug({ kind: 'tasmota', port: PLUG_PORT, on: true });
	const op = await startMockOctoPrint({ port: OP_PORT, apiKey: 'op-key-resume', powered: () => plug.state.on, printSeconds: 600, coolPerSecond: 5, connectMs: 50 });
	const printer = store.createPrinter({ name: 'Resume MK4', baseUrl: op.url, apiKey: 'op-key-resume', verifyTls: true, webcamUrl: null, color: 'violet' });
	after(async () => {
		printers.forget(printer.id);
		await plug.close();
		await op.close();
	});
	cfg.savePlug(printer.id, cfg.parsePlugInput({ kind: 'tasmota', config: { url: plug.url }, settings: { autoOff: { enabled: true, hotendC: 50, idleMinutes: 10 } } }));
	const fresh = () => {
		const s = new PowerService();
		s.deps = { timeoutMs: 2_000 };
		return s;
	};
	const audits = () => store.searchAudit({ printerId: printer.id, action: 'power.' }).map((e) => `${e.action}${e.detail ? `: ${e.detail}` : ''}`);
	const opPost = (path: string, body: unknown) => fetch(`${op.url}${path}`, { method: 'POST', headers: { 'x-api-key': 'op-key-resume', 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const connect = async () => {
		await opPost('/api/connection', { command: 'connect' });
		await until(async () => (await (await fetch(`${op.url}/__mock/state`)).json()).state === 'Operational', 'OctoPrint connected');
		await printers.poll(printer.id);
	};
	const snap = (state: 'printing' | 'operational' | 'unknown', tool: number | null) => ({ ...emptySnapshot(printer.id), state, temps: tool == null ? {} : { tool0: { actual: tool, target: 0 } } });
	await connect();

	// Armed by a print ending: saved with its deadline and conditions.
	const svc = fresh();
	await svc.refresh(printer.id);
	const t0 = Date.now() - 20 * M;
	svc.observe(printer.id, snap('printing', 210), t0 - M);
	svc.observe(printer.id, snap('operational', 200), t0);
	let saved = pending.loadPending(printer.id);
	assert.ok(saved, 'saved when armed');
	assert.equal(saved.armedAt, t0);
	assert.equal(saved.offAt, t0 + 10 * M);
	assert.equal(saved.hotendC, 50);
	assert.equal(saved.plugKind, 'tasmota');

	// "Keep on" clears it; arming again saves it again.
	assert.ok(svc.keepOn(printer.id, { user: null }));
	assert.equal(pending.loadPending(printer.id), null, 'cancelled: cleared');
	svc.observe(printer.id, snap('printing', 210), t0 - M);
	svc.observe(printer.id, snap('operational', 200), t0);
	assert.equal(pending.loadPending(printer.id)?.armedAt, t0);

	// Restart: a new service picks the countdown up, shows it, and does nothing before it has seen the printer.
	const after1 = fresh();
	assert.equal(after1.info(printer.id)?.countdown?.since, t0, 'resumed');
	after1.observe(printer.id, snap('unknown', null));
	assert.equal(plug.state.on, true, 'not switched off blind');
	assert.ok(pending.loadPending(printer.id), 'still saved');

	// The deadline passed while it was down: idle and cool now, so it switches off (after asking OctoPrint).
	await printers.poll(printer.id);
	assert.equal(printers.snapshot(printer.id)?.state, 'operational');
	await after1.tick();
	await until(() => !plug.state.on, 'auto power-off after the restart');
	await until(() => pending.loadPending(printer.id) === null, 'cleared once done');
	assert.ok(audits().some((a) => /^power\.auto_off: idle 10 min, hotend below 50 °C \(countdown resumed after a restart\)/.test(a)), audits().join('\n'));

	// Overdue, but printing now: the countdown is dropped and the plug stays on.
	plug.state.on = true;
	await connect();
	await fetch(`${op.url}/__mock/print?file=benchy.gcode`);
	await printers.poll(printer.id);
	assert.equal(printers.snapshot(printer.id)?.state, 'printing');
	pending.savePending({ ...saved, armedAt: Date.now() - 60 * M, offAt: Date.now() - 50 * M, savedAt: Date.now() - 60 * M });
	const after2 = fresh();
	assert.ok(after2.info(printer.id)?.countdown);
	await after2.tick();
	assert.equal(plug.state.on, true, 'never off mid-print');
	assert.equal(pending.loadPending(printer.id), null, 'dropped');
	assert.equal(after2.info(printer.id)?.countdown, null);
	assert.ok(audits().includes('power.auto_off.cancelled: A new print started (countdown resumed after a restart)'));

	// Overdue and idle, but the hotend is still hot: it waits (and stays saved) until it cools.
	await opPost('/api/job', { command: 'cancel' });
	await fetch(`${op.url}/__mock/heat?tool=150`);
	await printers.poll(printer.id);
	saved = { ...saved, armedAt: Date.now() - 60 * M, offAt: Date.now() - 50 * M };
	pending.savePending(saved);
	const after3 = fresh();
	await after3.tick();
	assert.equal(plug.state.on, true, 'hot: not yet');
	assert.equal(after3.info(printer.id)?.countdown?.cooling, true);
	assert.ok(pending.loadPending(printer.id), 'still saved while it waits');
	await until(async () => {
		await printers.poll(printer.id);
		await after3.tick();
		return !plug.state.on;
	}, 'off once cool');
	await until(() => pending.loadPending(printer.id) === null, 'cleared');

	// A saved countdown for a plug that was since removed, or with auto power-off turned off, is dropped.
	pending.savePending(saved);
	cfg.savePlug(printer.id, { ...cfg.getPlug(printer.id)!, settings: { ...cfg.getPlug(printer.id)!.settings, autoOff: { ...cfg.getPlug(printer.id)!.settings.autoOff, enabled: false } } });
	assert.equal(fresh().info(printer.id)?.countdown, null);
	assert.equal(pending.loadPending(printer.id), null);
	pending.savePending(saved);
	cfg.deletePlug(printer.id);
	await fresh().tick();
	assert.equal(pending.loadPending(printer.id), null);
});
