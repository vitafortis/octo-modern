import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-maintenance-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-maintenance';
const store = await import('../src/lib/server/store.ts');
const hs = await import('../src/lib/server/history/store.ts');
const m = await import('../src/lib/server/maintenance.ts');
const notify = await import('../src/lib/server/notify/settings.ts');
const { DEFAULT_TASKS } = await import('../src/lib/spools.ts');

const HOOK_PORT = 3227;
let hookServer: Server;
const hooks: { event: string; title: string; message: string; url: string | null }[] = [];

const printer = store.createPrinter({ name: 'Voron', baseUrl: 'http://127.0.0.1:9', apiKey: 'key-for-voron', verifyTls: true, webcamUrl: null, color: 'violet' });
const other = store.createPrinter({ name: 'Ender', baseUrl: 'http://127.0.0.1:9', apiKey: 'key-for-ender', verifyTls: true, webcamUrl: null, color: 'violet' });

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
	const hookChannel = notify.createChannel({ type: 'webhook', name: 'hook', secrets: { url: `http://127.0.0.1:${HOOK_PORT}/` } });
	notify.saveSettings({ publicUrl: 'https://octo.example', rules: [{ name: 'hook', printers: 'all', events: ['maintenance.due'], channels: [hookChannel.id] }] });
});
after(async () => {
	hookServer.closeAllConnections();
	await new Promise((r) => hookServer.close(r));
});

const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const add = (o: Partial<Parameters<typeof hs.insertPrint>[0]>) =>
	hs.insertPrint({ printerId: printer.id, printerName: 'Voron', file: 'x.gcode', path: 'x.gcode', origin: 'local', startedAt: days(1), result: 'success', ...o })!;

test('usage since a date: print hours, filament (grams when known, else from length) and days', () => {
	add({ startedAt: days(10), durationS: 3600 * 5, filamentMm: 10_000 }); // before the window
	hs.updatePrint(add({ startedAt: days(3), durationS: 3600 * 2, filamentMm: 10_000 }), { filamentG: 30 });
	add({ startedAt: days(2), durationS: 3600, filamentMm: 1000, result: 'cancelled' });
	add({ startedAt: days(1), durationS: 3600 * 9, result: 'printing' }); // still running: not counted
	add({ printerId: other.id, startedAt: days(1), durationS: 3600 * 50 });
	const u = m.usageSince(printer.id, days(5));
	assert.ok(Math.abs(u.hours - 3) < 1e-9, `hours ${u.hours}`);
	assert.ok(Math.abs(u.filament - (30 + 2.982) / 1000) < 0.0001, `kg ${u.filament}`);
	assert.ok(Math.abs(u.days - 5) < 0.001);
});

test('tasks: validation, defaults, status from history since last done', () => {
	assert.throws(() => m.parseTaskInput({ name: '', metric: 'hours', interval: 5 }), /name/);
	assert.throws(() => m.parseTaskInput({ name: 'x', metric: 'weeks', interval: 5 }), /metric/);
	assert.throws(() => m.parseTaskInput({ name: 'x', metric: 'days', interval: 0 }), /above 0/);
	assert.throws(() => m.parseTaskInput({ name: 'x', metric: 'days', interval: 1, lastDoneAt: '2999-01-01' }), /past/);
	const added = m.addDefaultTasks(printer.id, undefined, days(5));
	assert.equal(added.length, DEFAULT_TASKS.length);
	assert.equal(m.addDefaultTasks(printer.id).length, 0, 'not twice');
	const t = m.listTasks([printer.id]);
	const bed = t.find((x) => x.name === 'Clean the bed')!;
	assert.equal(bed.metric, 'days');
	assert.ok(Math.abs(bed.used - 5) < 0.01);
	assert.equal(bed.status, 'ok');
	// 3 print hours of 2 → overdue; sorted most urgent first.
	const hours = m.createTask(printer.id, { name: 'Tighten bolts', metric: 'hours', interval: 2, notes: null, lastDoneAt: days(5) });
	assert.equal(hours.status, 'overdue');
	assert.equal(m.listTasks([printer.id])[0].id, hours.id);
	const soon = m.createTask(printer.id, { name: 'Check fans', metric: 'days', interval: 5.4, notes: null, lastDoneAt: days(5) });
	assert.equal(soon.status, 'due', '≥ 90 % used');
	assert.equal(m.overdueCount([printer.id]), 1);
	assert.equal(m.overdueCount([other.id]), 0);
	assert.equal(m.overdueCount([]), 0);
});

test('maintenance.due: notified once per overdue task, with a link; marking done resets and logs', async () => {
	hooks.length = 0;
	const due = await m.notifyDue();
	assert.deepEqual(
		due.map((t) => t.name),
		['Tighten bolts']
	);
	assert.equal(hooks.length, 1);
	assert.equal(hooks[0].event, 'maintenance.due');
	assert.match(hooks[0].message, /^Voron: “Tighten bolts” is due \(every 2 print hours; 3\.0 \/ 2 h since it was last done\)\.$/);
	assert.equal(hooks[0].url, `https://octo.example/p/${printer.id}?tab=maintenance`);
	assert.equal((await m.notifyDue()).length, 0, 'only once');

	const task = m.listTasks([printer.id]).find((t) => t.name === 'Tighten bolts')!;
	const entry = m.markDone(task, { userId: null, label: 'Otto' }, 'All M3 bolts, blue threadlocker');
	assert.equal(entry.taskName, 'Tighten bolts');
	assert.equal(entry.doneBy, 'Otto');
	assert.equal(entry.used, 3);
	assert.equal(entry.printerName, 'Voron');
	const reset = m.getTask(task.id)!;
	assert.equal(reset.used, 0);
	assert.equal(reset.status, 'ok');
	assert.equal(reset.lastDoneBy, 'Otto');
	assert.equal(m.overdueCount([printer.id]), 0);
	// The next print counts again and makes it overdue again: notified again.
	add({ startedAt: new Date(Date.now() + 1000).toISOString(), durationS: 3 * 3600 });
	assert.equal(m.getTask(task.id)!.status, 'overdue');
	assert.equal((await m.notifyDue()).length, 1);
	// Log, newest first; editing; deleting keeps the log.
	assert.equal(m.listLog({ printerId: printer.id })[0].notes, 'All M3 bolts, blue threadlocker');
	assert.equal(m.updateTask(task.id, { interval: 10 })!.status, 'ok');
	assert.ok(m.deleteTask(task.id));
	assert.equal(m.listLog({ printerIds: [printer.id] }).length, 1);
	assert.equal(m.listLog({ printerIds: [] }).length, 0);
});

test('deleting a printer removes its tasks', () => {
	m.createTask(other.id, { name: 'x', metric: 'days', interval: 1, notes: null });
	assert.equal(m.listTasks([other.id]).length, 1);
	store.deletePrinter(other.id);
	assert.equal(m.listTasks([other.id]).length, 0);
});
