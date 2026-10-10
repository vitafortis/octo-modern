import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stateFromFlags, stateFromText, filamentMeters, formatDuration, heaterKeys, heaterLabel, jobActive, progressPercent, emptySnapshot } from '../src/lib/printer.ts';
import { parseJob, parseJobResponse, parsePrinterResponse, parsePushUpdate, parseTempProfiles, parseTemps, tempSample } from '../src/lib/server/octoprint/parse.ts';
import { normalizeBaseUrl, pushUrl } from '../src/lib/server/octoprint/client.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const flags = (on: string[]) =>
	Object.fromEntries(['operational', 'printing', 'cancelling', 'pausing', 'resuming', 'finishing', 'closedOrError', 'error', 'paused', 'ready', 'sdReady'].map((k) => [k, on.includes(k)]));

test('state flags map to one state, in-between states first', () => {
	assert.equal(stateFromFlags(flags(['operational', 'ready']), 'Operational'), 'operational');
	assert.equal(stateFromFlags(flags(['operational', 'printing']), 'Printing'), 'printing');
	assert.equal(stateFromFlags(flags(['operational', 'printing', 'cancelling']), 'Cancelling'), 'cancelling');
	assert.equal(stateFromFlags(flags(['operational', 'printing', 'pausing']), 'Pausing'), 'pausing');
	assert.equal(stateFromFlags(flags(['operational', 'paused']), 'Paused'), 'paused');
	assert.equal(stateFromFlags(flags(['operational', 'printing', 'resuming']), 'Resuming'), 'resuming');
	assert.equal(stateFromFlags(flags(['operational', 'printing', 'finishing']), 'Finishing'), 'finishing');
	assert.equal(stateFromFlags(flags(['closedOrError', 'error']), 'Error: Printer halted'), 'error');
	assert.equal(stateFromFlags(flags(['closedOrError']), 'Offline'), 'disconnected');
	assert.equal(stateFromFlags(flags(['closedOrError']), 'Offline after error'), 'error');
	assert.equal(stateFromFlags(flags(['closedOrError']), 'Detecting serial connection'), 'connecting');
	assert.equal(stateFromFlags(null, 'Printing from SD'), 'printing');
});

test('state text (REST /api/job) maps too', () => {
	assert.equal(stateFromText('Operational'), 'operational');
	assert.equal(stateFromText('Printing from SD'), 'printing');
	assert.equal(stateFromText('Sending file to SD'), 'printing');
	assert.equal(stateFromText('Offline'), 'disconnected');
	assert.equal(stateFromText('Offline after error'), 'error');
	assert.equal(stateFromText('Opening serial connection'), 'connecting');
	assert.equal(stateFromText('Paused'), 'paused');
	assert.equal(stateFromText(''), 'unknown');
	assert.equal(stateFromText('Something new'), 'unknown');
});

test('temperatures: absent heaters (null/null) are dropped, order is tools, bed, chamber', () => {
	const t = parseTemps({ tool1: { actual: 20, target: 0 }, chamber: { actual: null, target: null }, bed: { actual: 60.1, target: 60 }, tool0: { actual: 210.4, target: 210 }, time: 1 });
	assert.deepEqual(Object.keys(t).sort(), ['bed', 'tool0', 'tool1']);
	assert.deepEqual(heaterKeys(t), ['tool0', 'tool1', 'bed']);
	assert.equal(heaterLabel('tool0'), 'Hotend');
	assert.equal(heaterLabel('tool1', 2), 'Hotend 2');
	assert.deepEqual(tempSample({ time: 1791659771, tool0: { actual: 49.9, target: 50 }, chamber: { actual: null, target: null } }), { t: 1791659771000, v: { tool0: [49.9, 50] } });
	assert.equal(tempSample({ tool0: {} }), null, 'no time, no sample');
});

test('jobs: no file is null; filament per tool or legacy single tool', () => {
	assert.equal(parseJob({ file: { name: null }, estimatedPrintTime: null, filament: { length: null, volume: null }, user: null }), null);
	const j = parseJob({ file: { name: 'benchy.gcode', path: 'parts/benchy.gcode', display: 'Benchy (v2).gcode', origin: 'local', size: 1024, date: 5 }, estimatedPrintTime: 3600, filament: { tool0: { length: 1500, volume: 3.6 }, tool1: { length: 500, volume: null } } });
	assert.equal(j?.file?.display, 'Benchy (v2).gcode');
	assert.equal(j?.file?.path, 'parts/benchy.gcode');
	assert.equal(filamentMeters(j), 2);
	const legacy = parseJob({ file: { name: 'a.gcode' }, filament: { length: 250, volume: 1 } });
	assert.deepEqual(legacy?.filament, { tool0: { length: 250, volume: 1 } });
	assert.equal(legacy?.file?.origin, 'local', 'origin defaults to local');
});

test('REST responses from a real OctoPrint parse', () => {
	const job = parseJobResponse(fixture('rest-job-done.json'));
	assert.equal(job.state?.state, 'operational');
	assert.equal(job.job?.file?.name, 'tiny.gcode');
	assert.equal(job.progress?.completion, 100);
	const printer = parsePrinterResponse(fixture('rest-printer.json'));
	assert.equal(printer.state?.state, 'operational');
	assert.ok(printer.temps.tool0 && printer.temps.bed);
	assert.equal(printer.temps.chamber, undefined);
});

test('push "current" from a real print', () => {
	const msgs = fixture('push-print.json') as Record<string, unknown>[];
	const printing = msgs.map((m) => m.current).find((c) => (c as { state: { text: string } } | undefined)?.state.text === 'Printing');
	const u = parsePushUpdate(printing)!;
	assert.equal(u.state?.state, 'printing');
	assert.equal(u.job?.file?.name, 'tiny.gcode');
	assert.equal(u.job?.user, 'admin');
	assert.ok(u.progress && u.progress.completion! >= 0);
	assert.deepEqual(u.busyFiles, [{ origin: 'local', path: 'tiny.gcode' }]);
	assert.ok(Array.isArray(u.logs));
	assert.equal(parsePushUpdate(null), null);
});

test('progress helpers', () => {
	const s = { ...emptySnapshot('x'), state: 'printing' as const, progress: { completion: 42.4, printTime: 10, printTimeLeft: 20, printTimeLeftOrigin: 'linear', filepos: 1 } };
	assert.equal(progressPercent(s), 42.4);
	assert.equal(progressPercent({ ...s, state: 'operational' }), null, 'no progress when idle');
	assert.ok(jobActive('paused') && !jobActive('operational'));
	assert.equal(formatDuration(3725), '1h 02m');
	assert.equal(formatDuration(125), '2m 05s');
	assert.equal(formatDuration(null), '—');
});

test('temperature presets', () => {
	assert.deepEqual(parseTempProfiles({ temperature: { profiles: [{ name: 'PLA', extruder: 200, bed: 60, chamber: null }] } }), [{ name: 'PLA', extruder: 200, bed: 60, chamber: null }]);
	assert.deepEqual(parseTempProfiles({}), []);
});

test('base URLs are normalized; push URL uses ws(s)', () => {
	assert.equal(normalizeBaseUrl('192.168.1.5'), 'http://192.168.1.5');
	assert.equal(normalizeBaseUrl(' https://print.example.com/octoprint/ '), 'https://print.example.com/octoprint');
	assert.equal(normalizeBaseUrl('http://octopi.lan:5000/?x=1#y'), 'http://octopi.lan:5000');
	assert.throws(() => normalizeBaseUrl('ftp://x'), /http/);
	assert.throws(() => normalizeBaseUrl('http://user:pw@x'), /credentials/);
	assert.throws(() => normalizeBaseUrl(''), /Enter/);
	assert.equal(pushUrl('https://p.example/octoprint'), 'wss://p.example/octoprint/sockjs/websocket');
	assert.equal(pushUrl('http://10.0.0.2'), 'ws://10.0.0.2/sockjs/websocket');
});
