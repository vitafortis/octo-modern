import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrintDetector, type HistoryAction, type Observation } from '../src/lib/server/history/detector.ts';
import { aggregate, csvField, toCsv, weekOf } from '../src/lib/server/history/stats.ts';
import { downscale, shrinkJpeg } from '../src/lib/server/history/jpeg.ts';
import { parseLooseDate, printsFromFileStats, printsFromPrintJobHistory } from '../src/lib/server/history/import.ts';
import { LiveModel } from '../src/lib/server/octoprint/model.ts';
import jpeg from 'jpeg-js';
import type { JobInfo, PrinterState, Progress } from '../src/lib/printer.ts';
import type { PrintRecord } from '../src/lib/history.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const job = (path: string, extra: Partial<JobInfo> = {}): JobInfo => ({
	file: { name: path.split('/').pop()!, path, display: path.split('/').pop()!, origin: 'local', size: 1000, date: null },
	estimatedPrintTime: 600,
	filament: { tool0: { length: 2000, volume: 5 } },
	user: 'admin',
	...extra
});
const progress = (completion: number | null, printTime: number | null): Progress => ({ completion, printTime, printTimeLeft: null, printTimeLeftOrigin: null, filepos: null });
const obs = (atS: number, state: PrinterState, j: JobInfo | null, p: Progress | null): Observation => ({ at: T0 + atS * 1000, state, job: j, progress: p });
const types = (a: HistoryAction[]) => a.map((x) => x.type);

// --- poll-based transitions --------------------------------------------------------

test('poll: printing → operational at 100 % is a success, started when the print time says', () => {
	const d = new PrintDetector();
	assert.deepEqual(d.observe(obs(0, 'operational', null, null)), [], 'idle: nothing');
	// First noticed 25 s into the print (polls are 10 s apart).
	const start = d.observe(obs(30, 'printing', job('benchy.gcode'), progress(10, 25)));
	assert.deepEqual(types(start), ['start']);
	assert.equal(start[0].type === 'start' && start[0].startedAt, T0 + 5_000);
	assert.equal(start[0].type === 'start' && start[0].via, 'observe');
	assert.deepEqual(d.observe(obs(40, 'printing', job('benchy.gcode'), progress(50, 35))), [], 'still printing: nothing new');
	const end = d.observe(obs(50, 'operational', job('benchy.gcode'), progress(100, 44)));
	assert.equal(end.length, 1);
	const e = end[0];
	assert.ok(e.type === 'end');
	assert.equal(e.result, 'success');
	assert.equal(e.printTime, 44);
	assert.equal(e.completion, 100);
	assert.equal(e.endedAt, T0 + 50_000);
	assert.equal(d.active, null);
	assert.deepEqual(d.observe(obs(60, 'operational', job('benchy.gcode'), progress(100, 44))), [], 'and nothing after');
});

test('poll: a cancel (Cancelling seen) and an unexplained stop (left for the caller)', () => {
	const d = new PrintDetector();
	d.observe(obs(0, 'printing', job('a.gcode'), progress(5, 3)));
	d.observe(obs(10, 'cancelling', job('a.gcode'), progress(20, 13)));
	const [cancelled] = d.observe(obs(20, 'operational', job('a.gcode'), progress(null, null)));
	assert.ok(cancelled.type === 'end');
	assert.equal(cancelled.result, 'cancelled');
	assert.equal(cancelled.printTime, 13, 'the last print time seen');
	assert.equal(cancelled.completion, 20);

	d.observe(obs(100, 'printing', job('b.gcode'), progress(5, 3)));
	const [unknown] = d.observe(obs(110, 'operational', job('b.gcode'), progress(null, null)));
	assert.ok(unknown.type === 'end');
	assert.equal(unknown.result, null, 'no 100 % and no Cancelling: settled from OctoPrint’s file stats');
});

test('poll: error or disconnect fails the print; unreachable OctoPrint does not end it', () => {
	const d = new PrintDetector();
	d.observe(obs(0, 'printing', job('a.gcode'), progress(5, 3)));
	assert.deepEqual(d.observe(obs(10, 'offline', null, null)), [], 'OctoPrint unreachable: the print may go on');
	assert.deepEqual(d.observe(obs(20, 'unknown', null, null)), []);
	assert.deepEqual(d.observe(obs(30, 'printing', job('a.gcode'), progress(30, 33))), [], 'back, same print');
	const [failed] = d.observe(obs(40, 'error', job('a.gcode'), progress(31, 34)));
	assert.ok(failed.type === 'end');
	assert.equal(failed.result, 'failed');
	assert.equal(failed.reason, 'error');

	d.observe(obs(50, 'printing', job('b.gcode'), progress(1, 1)));
	const [gone] = d.observe(obs(60, 'disconnected', null, null));
	assert.ok(gone.type === 'end' && gone.result === 'failed' && gone.reason === 'disconnected');
});

test('poll: pause and resume, and a different file means the old print ended', () => {
	const d = new PrintDetector();
	d.observe(obs(0, 'printing', job('a.gcode'), progress(5, 3)));
	assert.deepEqual(types(d.observe(obs(10, 'paused', job('a.gcode'), progress(10, 8)))), ['pause']);
	assert.deepEqual(d.observe(obs(20, 'paused', job('a.gcode'), progress(10, 8))), []);
	assert.deepEqual(types(d.observe(obs(30, 'printing', job('a.gcode'), progress(12, 10)))), ['resume']);
	// Between two polls a.gcode ended and b.gcode started.
	const acts = d.observe(obs(40, 'printing', job('b.gcode'), progress(2, 4)));
	assert.deepEqual(types(acts), ['end', 'start']);
	assert.ok(acts[0].type === 'end' && acts[0].file.path === 'a.gcode' && acts[0].result === null);
	assert.ok(acts[1].type === 'start' && acts[1].file.path === 'b.gcode');
});

test('poll: a print that was running when the app stopped resumes, or ends', () => {
	const restore = { file: { name: 'a.gcode', display: 'a.gcode', path: 'a.gcode', origin: 'local' }, startedAt: T0, printTime: null, completion: 40, paused: false, cancelling: false };
	const still = new PrintDetector(restore);
	assert.deepEqual(still.observe(obs(600, 'printing', job('a.gcode'), progress(60, 590))), [], 'same print, no new entry');
	const done = new PrintDetector(restore);
	const [e] = done.observe(obs(600, 'operational', job('a.gcode'), progress(100, 580)));
	assert.ok(e.type === 'end' && e.result === 'success' && e.startedAt === T0 && e.printTime === 580);
});

test('poll: an active state without a file is ignored', () => {
	const d = new PrintDetector();
	assert.deepEqual(d.observe(obs(0, 'printing', null, null)), []);
});

// --- events ------------------------------------------------------------------------

const payload = (path: string, extra: Record<string, unknown> = {}) => ({ name: path, path, origin: 'local', size: 10, owner: 'admin', ...extra });

test('events: started, paused, resumed, done with OctoPrint’s print time', () => {
	const d = new PrintDetector();
	const [s] = d.event('PrintStarted', payload('a.gcode', { user: 'admin' }), T0);
	assert.ok(s.type === 'start' && s.via === 'event' && s.user === 'admin' && s.startedAt === T0);
	assert.deepEqual(types(d.event('PrintPaused', payload('a.gcode'), T0 + 5_000)), ['pause']);
	assert.deepEqual(types(d.event('PrintResumed', payload('a.gcode'), T0 + 9_000)), ['resume']);
	const [e] = d.event('PrintDone', payload('a.gcode', { time: 61.5 }), T0 + 65_000);
	assert.ok(e.type === 'end' && e.result === 'success' && e.printTime === 61.5 && e.via === 'event');
});

test('events: a cancel sends PrintCancelled and PrintFailed(cancelled): one entry, cancelled', () => {
	const d = new PrintDetector();
	d.event('PrintStarted', payload('a.gcode'), T0);
	d.event('PrintCancelling', payload('a.gcode'), T0 + 9_000);
	const first = d.event('PrintCancelled', payload('a.gcode', { time: 10 }), T0 + 10_000);
	assert.ok(first[0].type === 'end' && first[0].result === 'cancelled');
	assert.deepEqual(d.event('PrintFailed', payload('a.gcode', { time: 10, reason: 'cancelled' }), T0 + 10_100), [], 'the second report changes nothing');
	// The push 'current' frames that follow ("Cancelling", then "Operational") don't start another print.
	assert.deepEqual(d.observe(obs(11, 'cancelling', job('a.gcode'), progress(30, 10))), []);
	assert.deepEqual(d.observe(obs(12, 'operational', job('a.gcode'), progress(null, null))), []);
});

test('events win over stale state frames that arrive after them', () => {
	const d = new PrintDetector();
	d.observe(obs(0, 'operational', job('a.gcode'), progress(100, 14)));
	assert.deepEqual(types(d.event('PrintStarted', payload('b.gcode'), T0 + 1_000)), ['start']);
	// Batched frames from before the start: "Operational" with the new file selected.
	assert.deepEqual(d.observe(obs(1.3, 'operational', job('b.gcode'), progress(null, null))), [], 'not an end');
	assert.deepEqual(d.observe(obs(2, 'printing', job('b.gcode'), progress(3, 1))), []);
	const [end] = d.event('PrintCancelled', payload('b.gcode', { time: 9 }), T0 + 10_000);
	assert.ok(end.type === 'end' && end.result === 'cancelled' && end.printTime === 9);
	// …and a "Printing" frame from before the cancel.
	assert.deepEqual(d.observe(obs(10.2, 'printing', job('b.gcode'), progress(40, 9))), [], 'not a new print');
	assert.deepEqual(d.observe(obs(19, 'operational', job('b.gcode'), progress(null, null))), []);
	// After the grace period, observations count again.
	assert.deepEqual(types(d.observe(obs(30, 'printing', job('b.gcode'), progress(1, 1)))), ['start']);
});

test('events: PrintFailed with an error reason', () => {
	const d = new PrintDetector();
	d.event('PrintStarted', payload('a.gcode'), T0);
	const [e] = d.event('PrintFailed', payload('a.gcode', { time: 5, reason: 'error' }), T0 + 6_000);
	assert.ok(e.type === 'end' && e.result === 'failed' && e.reason === 'error');
});

test('events after a poll already ended the print amend it', () => {
	const d = new PrintDetector();
	d.observe(obs(0, 'printing', job('a.gcode'), progress(5, 3)));
	const [e] = d.observe(obs(10, 'operational', job('a.gcode'), progress(null, null)));
	assert.ok(e.type === 'end' && e.result === null);
	const [amend] = d.event('PrintFailed', payload('a.gcode', { time: 9, reason: 'error' }), T0 + 11_000);
	assert.ok(amend.type === 'amend' && amend.result === 'failed' && amend.printTime === 9 && amend.reason === 'error');
	assert.deepEqual(d.event('PrintFailed', payload('a.gcode', { time: 9, reason: 'error' }), T0 + 11_500), [], 'once');
});

test('events: an end we never saw start is recorded whole', () => {
	const d = new PrintDetector();
	const acts = d.event('PrintDone', payload('quick.gcode', { time: 4 }), T0 + 10_000);
	assert.deepEqual(types(acts), ['start', 'end']);
	assert.ok(acts[0].type === 'start' && acts[0].startedAt === T0 + 6_000);
	assert.ok(acts[1].type === 'end' && acts[1].result === 'success' && acts[1].printTime === 4);
});

test('a recorded OctoPrint print, through the live model, gives exactly one successful entry', () => {
	const m = new LiveModel('p1');
	const d = new PrintDetector();
	const actions: HistoryAction[] = [];
	let t = T0;
	m.observer = (e) => {
		t += 500;
		if (e.type === 'update') actions.push(...d.observe({ at: t, state: e.snapshot.state, job: e.snapshot.job, progress: e.snapshot.progress }));
		else if (e.type === 'event') actions.push(...d.event(e.name, e.payload, t));
	};
	for (const msg of fixture('push-print.json') as unknown[]) m.applyPush(msg);
	assert.deepEqual(types(actions), ['start', 'end']);
	const end = actions[1];
	assert.ok(end.type === 'end');
	assert.equal(end.result, 'success');
	assert.equal(end.via, 'event');
	assert.equal(end.file.path, 'tiny.gcode');
	assert.ok(Math.abs((end.printTime ?? 0) - 2.358) < 0.01, 'OctoPrint’s print time from PrintDone');
});

// --- stats -------------------------------------------------------------------------

const rec = (o: Partial<PrintRecord>): PrintRecord => ({
	id: 1,
	printerId: 'p1',
	printerName: 'MK4',
	file: 'a.gcode',
	path: 'a.gcode',
	origin: 'local',
	startedAt: '2026-10-05T10:00:00.000Z',
	endedAt: '2026-10-05T11:00:00.000Z',
	durationS: 3600,
	result: 'success',
	reason: null,
	filamentMm: 1000,
	estimatedS: 3500,
	completion: 100,
	startedBy: null,
	octoprintUser: null,
	source: 'live',
	hasThumbnail: false,
	notes: null,
	filamentG: null,
	material: null,
	costFilament: null,
	costEnergy: null,
	cost: null,
	...o
});

test('weeks start on Monday (UTC)', () => {
	assert.equal(weekOf('2026-10-05T10:00:00Z'), '2026-10-05'); // a Monday
	assert.equal(weekOf('2026-10-11T23:59:59Z'), '2026-10-05'); // the Sunday after
	assert.equal(weekOf('2026-10-12T00:00:00Z'), '2026-10-12');
	assert.equal(weekOf('nonsense'), '');
});

test('aggregate: totals, success rate, per printer and per week (gaps filled)', () => {
	const s = aggregate([
		rec({ printerId: 'p1', printerName: 'MK4', result: 'success', durationS: 3600, filamentMm: 1000 }),
		rec({ printerId: 'p1', printerName: 'MK4', result: 'failed', durationS: 600, filamentMm: 200, startedAt: '2026-10-07T10:00:00Z' }),
		rec({ printerId: 'p2', printerName: 'Voron', result: 'cancelled', durationS: 60, filamentMm: null, startedAt: '2026-09-21T10:00:00Z' }),
		rec({ printerId: 'p2', printerName: 'Voron', result: 'success', durationS: 1200, filamentMm: 500, startedAt: '2026-10-12T10:00:00Z' }),
		rec({ printerId: 'p2', printerName: 'Voron', result: 'printing', durationS: null, filamentMm: 999 })
	]);
	assert.equal(s.prints, 4, 'running prints are left out');
	assert.equal(s.success, 2);
	assert.equal(s.failed, 1);
	assert.equal(s.cancelled, 1);
	assert.equal(s.successRate, 0.5);
	assert.equal(s.printTime, 3600 + 600 + 60 + 1200);
	assert.equal(s.filamentMm, 1700);
	assert.deepEqual(
		s.perPrinter.map((p) => [p.printerName, p.prints, p.success, p.printTime, p.filamentMm]),
		[
			['MK4', 2, 1, 4200, 1200],
			['Voron', 2, 1, 1260, 500]
		]
	);
	assert.deepEqual(
		s.perWeek.map((w) => [w.week, w.prints]),
		[
			['2026-09-21', 1],
			['2026-09-28', 0],
			['2026-10-05', 2],
			['2026-10-12', 1]
		]
	);
	assert.equal(aggregate([]).successRate, null);
	assert.deepEqual(aggregate([]).perWeek, []);
});

test('aggregate keeps only the most recent weeks', () => {
	const s = aggregate([rec({ startedAt: '2025-01-06T10:00:00Z' }), rec({ startedAt: '2026-10-05T10:00:00Z' })], 4);
	assert.equal(s.perWeek.length, 4);
	assert.equal(s.perWeek.at(-1)!.week, '2026-10-05');
	assert.equal(s.prints, 2, 'totals still count everything');
});

// --- CSV ---------------------------------------------------------------------------

test('CSV fields: quoting and spreadsheet formula injection', () => {
	assert.equal(csvField(null), '');
	assert.equal(csvField(12.5), '12.5');
	assert.equal(csvField(-3), '-3', 'numbers are numbers');
	assert.equal(csvField('plain'), 'plain');
	assert.equal(csvField('a,b'), '"a,b"');
	assert.equal(csvField('say "hi"'), '"say ""hi"""');
	assert.equal(csvField('two\nlines'), '"two\nlines"');
	assert.equal(csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
	assert.equal(csvField('+1'), "'+1");
	assert.equal(csvField('@SUM(A1)'), "'@SUM(A1)");
});

test('CSV export: header, one row per print, CRLF', () => {
	const csv = toCsv([rec({ id: 7, file: 'part, v2.gcode', notes: 'layer shift at 3 mm', durationS: 3599.6, completion: 41.25, filamentMm: 812.34 }), rec({ id: 8, result: 'cancelled', startedBy: 'Otto' })]);
	const lines = csv.split('\r\n');
	assert.equal(lines.at(-1), '', 'ends with a line break');
	assert.equal(lines[0].split(',')[0], 'id');
	assert.equal(lines[0].split(',').length, 22);
	assert.match(lines[1], /^7,MK4,"part, v2\.gcode",a\.gcode,local,2026-10-05T10:00:00\.000Z,2026-10-05T11:00:00\.000Z,3600,success,,41\.3,812\.3,3500,,,live,layer shift at 3 mm,,,,,$/);
	assert.match(lines[2], /^8,.*,cancelled,.*,Otto,/);
	assert.equal(toCsv([]), `${lines[0]}\r\n`);
});

// --- thumbnails --------------------------------------------------------------------

function noiseJpeg(width: number, height: number): Uint8Array {
	const data = new Uint8Array(width * height * 4);
	let seed = 42;
	for (let i = 0; i < data.length; i++) data[i] = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
	return new Uint8Array(jpeg.encode({ width, height, data }, 95).data);
}

test('snapshots over 100 KB are scaled down to fit; small ones are kept as they are', () => {
	const big = noiseJpeg(1280, 720);
	assert.ok(big.length > 100 * 1024, `fixture is ${big.length} bytes`);
	const small = shrinkJpeg(big)!;
	assert.ok(small.length <= 100 * 1024, `${small.length} bytes`);
	const decoded = jpeg.decode(small, { useTArray: true });
	assert.ok(decoded.width <= 640 && decoded.width / decoded.height > 1.7, 'scaled, aspect kept');
	const tiny = noiseJpeg(64, 36);
	assert.equal(shrinkJpeg(tiny), tiny);
	assert.equal(shrinkJpeg(new Uint8Array([1, 2, 3, 4])), null, 'not a JPEG');
	const d = downscale({ width: 4, height: 2, data: new Uint8Array(32).fill(100) }, 2);
	assert.deepEqual([d.width, d.height, d.data[0], d.data[3]], [2, 1, 100, 255]);
});

// --- import ------------------------------------------------------------------------

test('import: each file’s last print from OctoPrint’s file statistics', () => {
	const prints = printsFromFileStats({
		files: [
			{ name: 'never.gcode', path: 'never.gcode', type: 'machinecode', origin: 'local' },
			{ name: 'ok.gcode', path: 'ok.gcode', display: 'ok.gcode', type: 'machinecode', origin: 'local', prints: { success: 2, failure: 0, last: { date: 1_790_000_000, success: true, printTime: 120 } }, gcodeAnalysis: { estimatedPrintTime: 100, filament: { tool0: { length: 500 } } } },
			{ type: 'folder', name: 'parts', path: 'parts', children: [{ name: 'bad.gcode', path: 'parts/bad.gcode', type: 'machinecode', prints: { success: 0, failure: 1, last: { date: 1_790_000_500, success: false } } }] }
		]
	});
	assert.equal(prints.length, 2);
	const ok = prints.find((p) => p.path === 'ok.gcode')!;
	assert.equal(ok.result, 'success');
	assert.equal(ok.endedAt, 1_790_000_000_000);
	assert.equal(ok.startedAt, 1_790_000_000_000 - 120_000);
	assert.equal(ok.filamentMm, 500);
	assert.equal(ok.key, 'stats:local:ok.gcode:1790000000');
	const bad = prints.find((p) => p.path === 'parts/bad.gcode')!;
	assert.equal(bad.result, 'failed');
	assert.equal(bad.reason, 'octoprint-stats');
	assert.equal(bad.durationS, null);
});

test('import: PrintJobHistory plugin entries, with its date formats', () => {
	assert.equal(parseLooseDate('2024-03-01T10:20:00Z'), Date.UTC(2024, 2, 1, 10, 20));
	assert.equal(parseLooseDate('01.03.2024 10:20'), new Date(2024, 2, 1, 10, 20).getTime());
	assert.equal(parseLooseDate(1_700_000_000), 1_700_000_000_000);
	assert.equal(parseLooseDate('soon'), null);
	const prints = printsFromPrintJobHistory({
		totalItemCount: 3,
		allPrintJobs: [
			{ databaseId: 1, fileName: 'a.gcode', filePathName: 'a.gcode', printStartDateTime: '2024-03-01 10:00:00', printEndDateTime: '2024-03-01 11:00:00', duration: 3600, printStatusResult: 'success', userName: 'bob', noteText: 'nice', filamentModel: { usedLength: 1234 } },
			{ databaseId: 2, fileName: 'b.gcode', printStartDateTime: '02.03.2024 09:00', duration: 60, printStatusResult: 'canceled' },
			{ databaseId: 3, fileName: 'c.gcode', printStartDateTime: '2024-03-03T09:00:00', printStatusResult: 'failed' },
			{ fileName: 'no-id.gcode' }
		]
	});
	assert.deepEqual(prints.map((p) => [p.key, p.result]), [['pjh:1', 'success'], ['pjh:2', 'cancelled'], ['pjh:3', 'failed']]);
	assert.equal(prints[0].user, 'bob');
	assert.equal(prints[0].notes, 'nice');
	assert.equal(prints[0].filamentMm, 1234);
	assert.equal(prints[1].endedAt, prints[1].startedAt + 60_000);
});
