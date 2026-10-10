import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-history-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-history';
const store = await import('../src/lib/server/store.ts');
const hs = await import('../src/lib/server/history/store.ts');
const { historyScope, canSeeEntry } = await import('../src/lib/server/history/access.ts');
const { adminOnlyApi, controlApi } = await import('../src/lib/server/access.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const { history } = await import('../src/lib/server/history/tracker.ts');

// Port 9 (discard) refuses connections: no OctoPrint, so file stats and snapshots are simply unavailable.
const printer = (name: string) => store.createPrinter({ name, baseUrl: 'http://127.0.0.1:9', apiKey: `key-for-${name}`, verifyTls: true, webcamUrl: null, color: 'violet' });
const a = printer('a');
const b = printer('b');
const admin = store.createUser({ email: 'admin@x.io', role: 'admin' });
const op = store.updateUser(store.createUser({ email: 'op@x.io', name: 'Otto', role: 'operator' }).id, { printerAccess: 'selected' })!;
store.setGrants(op.id, [a.id]);

after(() => {
	printers.forget(a.id);
	printers.forget(b.id);
});

const add = (o: Partial<Parameters<typeof hs.insertPrint>[0]>) =>
	hs.insertPrint({ printerId: a.id, printerName: 'a', file: 'x.gcode', path: 'x.gcode', origin: 'local', startedAt: '2026-10-05T10:00:00.000Z', result: 'success', ...o })!;

test('history access: admin-only deletes and imports, timelapse settings for admins', () => {
	assert.ok(adminOnlyApi('DELETE', '/api/history/12'));
	assert.ok(!adminOnlyApi('PATCH', '/api/history/12'), 'notes: operators too (checked per printer)');
	assert.ok(!adminOnlyApi('GET', '/api/history'));
	assert.ok(adminOnlyApi('POST', '/api/history/import'));
	assert.ok(adminOnlyApi('POST', '/api/printers/abc/timelapse'));
	assert.ok(!adminOnlyApi('GET', '/api/printers/abc/timelapse'));
	assert.ok(!adminOnlyApi('DELETE', '/api/printers/abc/timelapse/file'), 'deleting a timelapse: operators');
	assert.ok(controlApi('DELETE', '/api/printers/abc/timelapse/file'), '…but not viewers');
	assert.ok(controlApi('POST', '/api/printers/abc/timelapse/unrendered'));
});

test('filters, paging and who sees what', () => {
	const ids = [
		add({ file: 'benchy.gcode', path: 'benchy.gcode', startedAt: '2026-10-01T10:00:00.000Z', result: 'success' }),
		add({ file: 'cube.gcode', path: 'cal/cube.gcode', startedAt: '2026-10-02T10:00:00.000Z', result: 'failed', notes: 'spaghetti' }),
		add({ printerId: b.id, printerName: 'b', file: 'vase.gcode', path: 'vase.gcode', startedAt: '2026-10-03T10:00:00.000Z', result: 'cancelled' }),
		add({ printerId: 'removed', printerName: 'gone', file: 'old.gcode', path: 'old.gcode', startedAt: '2026-09-01T10:00:00.000Z' })
	];
	const all = hs.listPrints({ printerIds: historyScope(admin) });
	assert.deepEqual(all.map((r) => r.file), ['vase.gcode', 'cube.gcode', 'benchy.gcode', 'old.gcode'], 'admins: everything, newest first, removed printers too');
	assert.deepEqual(hs.listPrints({ printerIds: historyScope(op) }).map((r) => r.file), ['cube.gcode', 'benchy.gcode'], 'operators: their printers only');
	assert.ok(!canSeeEntry(op, { printerId: b.id }) && canSeeEntry(admin, { printerId: 'removed' }));
	assert.deepEqual(hs.listPrints({ result: 'failed' }).map((r) => r.id), [ids[1]]);
	assert.deepEqual(hs.listPrints({ printer: b.id }).map((r) => r.id), [ids[2]]);
	assert.deepEqual(hs.listPrints({ q: 'spag' }).map((r) => r.id), [ids[1]], 'search covers notes');
	assert.deepEqual(hs.listPrints({ q: 'cal/' }).map((r) => r.id), [ids[1]], 'and paths');
	assert.deepEqual(hs.listPrints({ q: '%' }), [], 'LIKE wildcards are literal');
	assert.deepEqual(hs.listPrints({ from: '2026-10-02', to: '2026-10-02' }).map((r) => r.id), [ids[1]], 'date range is inclusive');
	assert.deepEqual(hs.listPrints({ from: '2026-10-02T00:00:00Z' }).map((r) => r.id), [ids[2], ids[1]]);
	const page1 = hs.listPrints({ limit: 2 });
	const page2 = hs.listPrints({ limit: 2, before: page1.at(-1)!.id });
	assert.deepEqual([...page1, ...page2].map((r) => r.id), all.map((r) => r.id), 'paging continues where the last page ended');
	assert.equal(hs.countPrints({ printerIds: historyScope(op) }), 2);
	assert.equal(hs.countPrints({ printerIds: [] }), 0);
	assert.equal(hs.insertPrint({ printerId: a.id, printerName: 'a', file: 'i', path: 'i', origin: 'local', startedAt: '2026-01-01T00:00:00Z', result: 'success', externalKey: 'k1' }) != null, true);
	assert.equal(hs.insertPrint({ printerId: a.id, printerName: 'a', file: 'i', path: 'i', origin: 'local', startedAt: '2026-01-01T00:00:00Z', result: 'success', externalKey: 'k1' }), null, 'imports are idempotent');
	for (const id of [...ids]) hs.deletePrint(id);
});

test('the starter comes from the audit log, only for the same file', () => {
	const since = new Date(Date.now() - 60_000).toISOString();
	store.addAudit({ userId: op.id, userEmail: op.email, action: 'job.start', printerId: a.id, printerName: 'a', detail: 'parts/gear.gcode', ip: null });
	assert.deepEqual(hs.auditedStarter(a.id, since, ['gear.gcode']), { userId: op.id, label: 'Otto' });
	assert.equal(hs.auditedStarter(a.id, since, ['other.gcode']), null, 'a start of another file says nothing about this one');
	assert.equal(hs.auditedStarter(b.id, since, ['gear.gcode']), null);
	assert.equal(hs.auditedStarter(a.id, new Date(Date.now() + 60_000).toISOString(), ['gear.gcode']), null, 'too old');
});

const printing = (completion: number, printTime: number) => ({
	printer: { state: { text: 'Printing', flags: { printing: true, operational: true } }, temperature: {} },
	job: {
		job: { file: { name: 'gear.gcode', path: 'parts/gear.gcode', display: 'gear.gcode', origin: 'local' }, filament: { tool0: { length: 2000 } }, estimatedPrintTime: 100, user: 'admin' },
		progress: { completion, printTime, printTimeLeft: 10 },
		state: 'Printing'
	}
});
const ready = (completion: number | null) => ({
	printer: { state: { text: 'Operational', flags: { operational: true, ready: true } }, temperature: {} },
	job: { job: { file: { name: 'gear.gcode', path: 'parts/gear.gcode', origin: 'local' } }, progress: { completion, printTime: completion ? 95 : null }, state: 'Operational' }
});

test('the tracker records prints from polls alone, with the user and the filament used', async () => {
	history.start();
	const model = printers.model(a.id)!;
	model.applyPoll(ready(null));
	model.applyPoll(printing(25, 30));
	await history.idle();
	const [open] = hs.openPrints(a.id);
	assert.ok(open, 'an entry opens while printing');
	assert.equal(open.result, 'printing');
	assert.equal(open.startedBy, 'Otto', 'started through octo·modern by Otto (audit above)');
	assert.equal(open.octoprintUser, 'admin');
	assert.equal(open.filamentMm, 2000, 'the analysis total while it runs');
	assert.ok(Math.abs(Date.parse(open.startedAt) - (Date.now() - 30_000)) < 5_000, 'start backdated by the print time');

	model.applyPoll(printing(50, 60));
	model.applyPoll(ready(null));
	await history.idle();
	const cancelled = hs.getPrint(open.id)!;
	assert.equal(cancelled.result, 'cancelled', 'stopped short without stats from OctoPrint: cancelled');
	assert.equal(cancelled.completion, 50);
	assert.equal(cancelled.filamentMm, 1000, 'half the analysis total');
	assert.equal(cancelled.durationS, 60);
	assert.ok(cancelled.endedAt);
	assert.deepEqual(hs.openPrints(a.id), []);

	model.applyPoll(printing(80, 5));
	model.applyPoll(ready(100));
	await history.idle();
	const [done] = hs.listPrints({ printer: a.id, limit: 1 });
	assert.notEqual(done.id, open.id, 'a second print, a second entry');
	assert.equal(done.result, 'success');
	assert.equal(done.completion, 100);
	assert.equal(done.filamentMm, 2000);
	assert.equal(done.durationS, 95, 'OctoPrint’s print time at the end');
	assert.equal(hs.listPrints({ printer: a.id, q: 'gear' }).length, 2);
});
