import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-stats-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-stats';
const store = await import('../src/lib/server/store.ts');
const hs = await import('../src/lib/server/history/store.ts');
const { localDate, makeBuckets, rangeStart, startOfDay, validTimeZone } = await import('../src/lib/server/history/buckets.ts');
const { statsReport } = await import('../src/lib/server/history/report.ts');
const { statsQuery } = await import('../src/lib/server/history/stats-access.ts');
const { historyScope } = await import('../src/lib/server/history/access.ts');
const { toCsv, CSV_COLUMNS } = await import('../src/lib/server/history/stats.ts');
const { adminOnlyApi, controlApi } = await import('../src/lib/server/access.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');

const iso = (t: number) => new Date(t).toISOString();
const H = 3_600_000;

// --- buckets (pure) ------------------------------------------------------------------

test('time zones: unknown ones are rejected, known ones normalised', () => {
	assert.equal(validTimeZone('Europe/Berlin'), 'Europe/Berlin');
	assert.equal(validTimeZone('UTC'), 'UTC');
	assert.equal(validTimeZone('Mars/Olympus'), null);
	assert.equal(validTimeZone(''), null);
	assert.equal(validTimeZone(42), null);
	assert.equal(validTimeZone('x'.repeat(100)), null);
});

test('local midnight follows DST, also where midnight itself is skipped', () => {
	assert.equal(iso(startOfDay(2026, 10, 25, 'Europe/Berlin')), '2026-10-24T22:00:00.000Z', 'still summer time at midnight');
	assert.equal(iso(startOfDay(2026, 10, 26, 'Europe/Berlin')), '2026-10-25T23:00:00.000Z', 'winter time');
	assert.equal(iso(startOfDay(2026, 3, 29, 'Europe/Berlin')), '2026-03-28T23:00:00.000Z');
	assert.equal(iso(startOfDay(2026, 3, 30, 'Europe/Berlin')), '2026-03-29T22:00:00.000Z');
	assert.equal(iso(startOfDay(2026, 1, 0, 'UTC')), '2025-12-31T00:00:00.000Z', 'day 0 overflows to the month before');
	assert.equal(iso(startOfDay(2026, 13, 1, 'America/New_York')), '2027-01-01T05:00:00.000Z', 'month 13 overflows to the next year');
	// Chile starts summer time at midnight: 6 September 2026 begins at 01:00 (-03).
	const cl = startOfDay(2026, 9, 6, 'America/Santiago');
	assert.equal(localDate(cl, 'America/Santiago'), '2026-09-06');
	assert.equal(localDate(cl - 1, 'America/Santiago'), '2026-09-05', 'the very first instant of the day');
});

test('daily buckets: 30 days ending today, the DST day is 25 hours long', () => {
	const now = Date.parse('2026-10-30T12:00:00Z');
	const { from, granularity } = rangeStart('30d', now, 'Europe/Berlin', null);
	assert.equal(granularity, 'day');
	assert.equal(iso(from!), '2026-09-30T22:00:00.000Z', '1 October, Berlin midnight');
	const b = makeBuckets(from!, now + 1, 'day', 'Europe/Berlin');
	assert.equal(b.length, 30);
	assert.equal(b[0].key, '2026-10-01');
	assert.equal(b.at(-1)!.key, '2026-10-30');
	const dst = b.find((x) => x.key === '2026-10-25')!;
	assert.equal(dst.end - dst.start, 25 * H);
	for (let i = 1; i < b.length; i++) assert.equal(b[i].start, b[i - 1].end, 'contiguous');
});

test('weekly buckets start on Monday and cross month boundaries', () => {
	const now = Date.parse('2026-10-11T09:00:00Z'); // a Sunday
	const { from, granularity } = rangeStart('90d', now, 'UTC', null);
	assert.equal(granularity, 'week');
	assert.equal(iso(from!), '2026-07-14T00:00:00.000Z');
	const b = makeBuckets(from!, now + 1, 'week', 'UTC');
	assert.equal(b[0].key, '2026-07-13', 'the Monday on or before the range start');
	assert.equal(b.at(-1)!.key, '2026-10-05');
	const cross = b.find((x) => x.key === '2026-09-28')!;
	assert.equal(iso(cross.end), '2026-10-05T00:00:00.000Z', 'Sep 28 – Oct 4 is one week');
	assert.ok(b.every((x) => new Date(`${x.key}T00:00:00Z`).getUTCDay() === 1));
});

test('monthly buckets: 12 months, month lengths and offsets of the zone', () => {
	const now = Date.parse('2026-10-11T09:00:00Z');
	const { from, granularity } = rangeStart('12m', now, 'America/New_York', null);
	assert.equal(granularity, 'month');
	assert.equal(iso(from!), '2025-11-01T04:00:00.000Z', '1 November 2025, still daylight time');
	const b = makeBuckets(from!, now + 1, 'month', 'America/New_York');
	assert.deepEqual(b.map((x) => x.key), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
	const feb = b.find((x) => x.key === '2026-02')!;
	assert.equal(iso(feb.start), '2026-02-01T05:00:00.000Z');
	assert.equal((feb.end - feb.start) / (24 * H), 28);
	const mar = b.find((x) => x.key === '2026-03')!;
	assert.equal(iso(mar.end), '2026-04-01T04:00:00.000Z', 'DST began in March: 31 days less an hour');
});

test('"all" starts at the first print, bucketed by how long ago that was', () => {
	const now = Date.parse('2026-10-11T09:00:00Z');
	assert.deepEqual(rangeStart('all', now, 'UTC', null), { from: null, granularity: 'month' });
	assert.equal(rangeStart('all', now, 'UTC', now - 10 * 24 * H).granularity, 'day');
	assert.equal(rangeStart('all', now, 'UTC', now - 100 * 24 * H).granularity, 'week');
	assert.equal(rangeStart('all', now, 'UTC', now - 400 * 24 * H).granularity, 'month');
});

// --- the report (SQL) ----------------------------------------------------------------

const printer = (name: string) => store.createPrinter({ name, baseUrl: 'http://127.0.0.1:9', apiKey: `key-for-${name}`, verifyTls: true, webcamUrl: null, color: 'violet' });
const a = printer('Prusa MK4');
const b = printer('Voron');
const admin = store.createUser({ email: 'admin@x.io', role: 'admin' });
const viewer = store.updateUser(store.createUser({ email: 'v@x.io', role: 'viewer' }).id, { printerAccess: 'selected' })!;
store.setGrants(viewer.id, [a.id]);
after(() => {
	printers.forget(a.id);
	printers.forget(b.id);
});

const add = (o: Partial<Parameters<typeof hs.insertPrint>[0]>) =>
	hs.insertPrint({ printerId: a.id, printerName: 'Prusa MK4', file: 'benchy.gcode', path: 'benchy.gcode', origin: 'local', startedAt: '2026-10-05T10:00:00.000Z', result: 'success', durationS: 3600, filamentMm: 1000, ...o })!;

const NOW = Date.parse('2026-11-02T12:00:00Z');
// Late on 31 October in UTC, but already 1 November in Berlin.
add({ startedAt: '2026-10-31T23:30:00.000Z', durationS: 1800 });
add({ startedAt: '2026-10-15T10:00:00.000Z', file: 'cube.gcode', path: 'cal/cube.gcode', result: 'failed', reason: 'error', durationS: 600 });
add({ startedAt: '2026-10-16T10:00:00.000Z', file: 'cube.gcode', path: 'cal/cube.gcode', result: 'success', durationS: 1200 });
add({ startedAt: '2026-10-17T10:00:00.000Z', file: 'cube.gcode', path: 'cal/cube.gcode', result: 'success', durationS: 1000 });
add({ printerId: b.id, printerName: 'Voron', startedAt: '2026-10-20T10:00:00.000Z', file: 'secret.gcode', path: 'secret.gcode', result: 'cancelled', durationS: 7200 });
add({ printerId: 'gone', printerName: 'Old Ender', startedAt: '2026-10-21T10:00:00.000Z', file: 'old.gcode', path: 'old.gcode' });
// Still running: counts for utilisation, not for the totals.
add({ startedAt: '2026-11-02T11:00:00.000Z', result: 'printing', durationS: null, file: 'now.gcode', path: 'now.gcode' });
// Outside 30 days.
add({ startedAt: '2026-06-01T10:00:00.000Z', file: 'june.gcode', path: 'june.gcode' });

test('buckets differ by time zone across a month boundary', async () => {
	const berlin = await statsReport({ range: '12m', scope: null, timeZone: 'Europe/Berlin', now: NOW });
	const utc = await statsReport({ range: '12m', scope: null, timeZone: 'UTC', now: NOW });
	const secs = (r: typeof berlin, key: string) => Object.values(r.buckets.find((x) => x.key === key)!.printTime).reduce((s, v) => s + v, 0);
	assert.equal(secs(berlin, '2026-11'), 1800, 'Berlin: the late print is November’s');
	assert.equal(secs(utc, '2026-11'), 0);
	assert.equal(secs(utc, '2026-10'), secs(berlin, '2026-10') + 1800);
	assert.equal(berlin.buckets.at(-1)!.key, '2026-11');
	assert.equal(berlin.totals.prints, 7, 'running prints are left out');
});

test('totals, files, reasons, utilisation', async () => {
	const r = await statsReport({ range: '30d', scope: null, timeZone: 'UTC', now: NOW });
	assert.equal(r.granularity, 'day');
	assert.deepEqual([r.totals.prints, r.totals.success, r.totals.failed, r.totals.cancelled], [6, 4, 1, 1]);
	assert.equal(r.totals.printTime, 1800 + 600 + 1200 + 1000 + 7200 + 3600);
	assert.equal(r.totals.avgPrintTime, r.totals.printTime / 6);
	assert.equal(r.totals.filamentMm, 6000);
	assert.ok(r.totals.filamentG > 0, 'grams from the default material');
	assert.equal(r.totals.costed, 0, 'no costs recorded: the tile hides');
	const cube = r.files.find((f) => f.path === 'cal/cube.gcode')!;
	assert.equal(r.files[0].path, 'cal/cube.gcode', 'most printed first');
	assert.deepEqual([cube.prints, cube.success, cube.avgPrintTime, cube.lastPrinted], [3, 2, 1100, '2026-10-17T10:00:00.000Z'], 'average of the successful prints');
	assert.deepEqual(r.reasons, [
		{ result: 'cancelled', reason: null, count: 1 },
		{ result: 'failed', reason: 'error', count: 1 }
	]);
	const ua = r.utilisation.find((u) => u.printerId === a.id)!;
	assert.equal(ua.printSecs, 1800 + 600 + 1200 + 1000 + 3600, 'the running print counts until now');
	assert.ok(Math.abs(ua.share - ua.printSecs / r.rangeSecs) < 1e-9);
	assert.deepEqual(
		r.printers.map((p) => [p.name, p.removed]),
		[
			['Prusa MK4', false],
			['Voron', false],
			['Old Ender', true]
		],
		'admins: removed printers too, after the current ones'
	);
	assert.equal(r.spools, null, 'no Spoolman');
	assert.deepEqual(r.materials.map((m) => m.material), ['PLA']);
});

test('utilisation clips prints that overlap the start of the range', async () => {
	const id = add({ printerId: 'clip', printerName: 'Clip', startedAt: iso(NOW - 30 * 24 * H - 2 * H), durationS: 3 * 3600, file: 'long.gcode', path: 'long.gcode' });
	const r = await statsReport({ range: '30d', scope: ['clip'], timeZone: 'UTC', now: NOW });
	// 30d starts at midnight 29 days ago (2026-10-04T00:00Z); the print ran 2026-10-03T10:00–13:00: outside.
	assert.equal(r.utilisation.length, 0);
	const id2 = add({ printerId: 'clip', printerName: 'Clip', startedAt: '2026-10-03T22:00:00.000Z', durationS: 4 * 3600, file: 'long.gcode', path: 'long.gcode' });
	const r2 = await statsReport({ range: '30d', scope: ['clip'], timeZone: 'UTC', now: NOW });
	assert.equal(r2.utilisation[0].printSecs, 2 * 3600, 'only the two hours after midnight');
	assert.equal(r2.totals.prints, 0, 'it started before the range, so it isn’t one of its prints');
	hs.deletePrint(id);
	hs.deletePrint(id2);
});

test('access: viewers only get their printers, and nothing about the others', async () => {
	const url = (q: string) => new URL(`http://x/api/stats?${q}`);
	const q = statsQuery(viewer, url('range=30d&tz=Europe/Berlin'));
	assert.deepEqual(q.scope, [a.id]);
	assert.equal(q.timeZone, 'Europe/Berlin');
	const r = await statsReport({ ...q, now: NOW });
	assert.deepEqual(r.printers.map((p) => p.id), [a.id]);
	assert.ok(!r.files.some((f) => f.file === 'secret.gcode' || f.file === 'old.gcode'));
	assert.ok(!r.utilisation.some((u) => u.printerId !== a.id));
	assert.ok(r.buckets.every((bk) => Object.keys(bk.printTime).every((id) => id === a.id)));
	assert.equal(r.totals.cancelled, 0, 'the Voron’s cancelled print isn’t counted');
	assert.throws(() => statsQuery(viewer, url(`printer=${b.id}`)), /not found/i, 'a hidden printer 404s');
	assert.throws(() => statsQuery(viewer, url('printer=gone')), /not found/i);
	const adminQ = statsQuery(admin, url('printer=gone&range=bogus&tz=Nowhere/Land'));
	assert.equal(adminQ.range, '30d', 'unknown ranges fall back to 30 days');
	assert.equal(adminQ.timeZone, process.env.TZ && validTimeZone(process.env.TZ) ? validTimeZone(process.env.TZ) : Intl.DateTimeFormat().resolvedOptions().timeZone, 'unknown zones: the server’s');
	const gone = await statsReport({ ...adminQ, now: NOW });
	assert.deepEqual([gone.totals.prints, gone.files.map((f) => f.file)], [1, ['old.gcode']], 'admins can pick a removed printer');
	assert.ok(gone.printers.some((p) => p.name === 'Old Ender' && p.removed), 'the picker still lists every printer');
	assert.ok(!adminOnlyApi('GET', '/api/stats') && !controlApi('GET', '/api/stats'), 'every role can read stats');
});

test('costs show once prints carry them', async () => {
	const id = add({ startedAt: '2026-10-22T10:00:00.000Z' });
	hs.updatePrint(id, { costFilament: 0.5, costEnergy: 0.25, filamentG: 3, material: 'PETG' });
	const r = await statsReport({ range: '30d', scope: null, timeZone: 'UTC', now: NOW });
	assert.equal(r.totals.costed, 1);
	assert.equal(r.totals.cost, 0.75);
	assert.deepEqual(r.materials.map((m) => m.material).sort(), ['PETG', 'PLA']);
	hs.deletePrint(id);
});

/** RFC 4180 parser, to read the export back. */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let f = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') (f += '"'), i++;
			else if (c === '"') quoted = false;
			else f += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') row.push(f), (f = '');
		else if (c === '\r' && text[i + 1] === '\n') row.push(f), rows.push(row), (row = []), (f = ''), i++;
		else f += c;
	}
	return rows;
}

test('CSV export of a range: rows of visible printers only, tricky names survive a round trip', () => {
	const names = ['=cmd|"/c calc"!A1.gcode', 'he said "hi", twice.gcode', 'two\r\nlines.gcode', '\tindent.gcode', 'Ünïcødé ✓.gcode', '-minus.gcode'];
	const ids = names.map((n, i) => add({ file: n, path: n, startedAt: iso(NOW - (i + 1) * H), notes: i === 1 ? 'note, with comma' : null }));
	const from = iso(NOW - 10 * H);
	const csv = toCsv(hs.listPrints({ from, printerIds: historyScope(viewer), limit: 100_000 }));
	assert.ok(csv.endsWith('\r\n'));
	const rows = parseCsv(csv);
	assert.deepEqual(rows[0], [...CSV_COLUMNS]);
	const files = rows.slice(1).map((r) => r[CSV_COLUMNS.indexOf('file')]);
	assert.ok(files.includes("'=cmd|\"/c calc\"!A1.gcode"), 'formulas are defused');
	assert.ok(files.includes('he said "hi", twice.gcode'));
	assert.ok(files.includes('two\r\nlines.gcode'), 'line breaks stay inside the quoted field');
	assert.ok(files.includes("'\tindent.gcode"));
	assert.ok(files.includes("'-minus.gcode"));
	assert.ok(files.includes('Ünïcødé ✓.gcode'));
	assert.ok(rows.slice(1).every((r) => r.length === CSV_COLUMNS.length), 'every row has every column');
	assert.ok(!files.includes('secret.gcode'));
	const csvB = toCsv(hs.listPrints({ from, printerIds: [b.id], limit: 100_000 }));
	assert.equal(parseCsv(csvB).length, 1, 'only the header when the range is empty');
	for (const id of ids) hs.deletePrint(id);
});

test('filament per spool, listed by number when Spoolman doesn’t answer', async () => {
	const { saveSpoolmanSettings } = await import('../src/lib/server/spools/spoolman.ts');
	saveSpoolmanSettings({ url: 'http://127.0.0.1:9' }); // port 9 refuses: no real Spoolman
	const id = add({ startedAt: '2026-10-23T10:00:00.000Z' });
	const hidden = add({ printerId: b.id, printerName: 'Voron', startedAt: '2026-10-23T11:00:00.000Z' });
	const use = store.sqlite().prepare(`INSERT INTO spool_usage (print_id, tool, spool_id, target_mm, reported_mm, final, updated_at) VALUES (?, ?, ?, ?, 0, 1, '2026-10-23T12:00:00Z')`);
	use.run(id, 0, 7, 1500);
	use.run(id, 1, 8, 500);
	use.run(hidden, 0, 9, 900);
	const r = await statsReport({ range: '30d', scope: [a.id], timeZone: 'UTC', now: NOW });
	assert.deepEqual(r.spools?.map((s) => [s.spoolId, s.filamentMm, s.prints, s.name]), [
		[7, 1500, 1, null],
		[8, 500, 1, null]
	]);
	assert.ok(r.spools![0].filamentG! > 4 && r.spools![0].filamentG! < 5, '1.5 m of 1.75 mm PLA ≈ 4.5 g');
	hs.deletePrint(id);
	hs.deletePrint(hidden);
	saveSpoolmanSettings({ url: '' });
});
