// Klipper printers through Moonraker: status → snapshot mapping, files, controls → RPC/G-code,
// auto-detection, the JSON-RPC websocket and polling, history import and the manager. Mocks
// listen on 5550–5559 (this feature's port range); nothing real is contacted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-moonraker-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-moonraker';

const parse = await import('../src/lib/server/moonraker/parse.ts');
const { MoonrakerClient, websocketUrl } = await import('../src/lib/server/moonraker/client.ts');
const { MoonrakerBackend, withFormFields } = await import('../src/lib/server/moonraker/backend.ts');
const { MoonrakerFeed, MoonrakerSession, pollMoonraker } = await import('../src/lib/server/moonraker/live.ts');
const { analyzeKind, detectKind, testMoonraker } = await import('../src/lib/server/moonraker/probe.ts');
const { testPrinter } = await import('../src/lib/server/backend/probe.ts');
const { LiveModel } = await import('../src/lib/server/octoprint/model.ts');
const { openWebSocket } = await import('../src/lib/server/octoprint/transport.ts');
const { multipartParts } = await import('../src/lib/server/library/send.ts');
const store = await import('../src/lib/server/store.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const { backendFor, octoprintClient } = await import('../src/lib/server/backend/index.ts');
const { importHistory, printsFromMoonrakerHistory } = await import('../src/lib/server/history/import.ts');
const { features, hiddenTabs, canReach } = await import('../src/lib/printer-kind.ts');
const { startMockMoonraker } = await import('../scripts/e2e/mock-moonraker.mjs');

const PORTS = { plain: 5550, keyed: 5551, octo: 5552, live: 5553, manager: 5554 };
const KEY = 'moonraker-api-key-0123456789abcdef';

const mr = await startMockMoonraker({ port: PORTS.plain, tickMs: 50, printSeconds: 1.2, webcam: { stream: '/webcam/?action=stream', snapshot: '/webcam/?action=snapshot' } });
const keyed = await startMockMoonraker({ port: PORTS.keyed, apiKey: KEY, tickMs: 50 });
after(async () => {
	for (const p of store.listPrinters()) printers.forget(p.id);
	await mr.close();
	await keyed.close();
});

const client = (m = mr, apiKey = '') => new MoonrakerClient({ baseUrl: m.url, apiKey, verifyTls: true }, 5_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, label: string, ms = 5_000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await fn();
		if (v) return v;
		await sleep(25);
	}
	throw new Error(`timed out: ${label}`);
}

// --- pure mapping ------------------------------------------------------------------------

const OBJECTS = ['webhooks', 'print_stats', 'virtual_sdcard', 'toolhead', 'gcode_move', 'fan', 'extruder', 'extruder1', 'heater_bed', 'temperature_sensor raspberry_pi', 'temperature_fan chamber_fan', 'gcode_macro PRINT_START', 'gcode_macro _HELPER', 'gcode_macro CLEAN'];

test('heaters: extruders → toolN, heater_bed → bed, a chamber fan/heater → chamber; subscription', () => {
	const map = parse.heaterMap(OBJECTS);
	assert.deepEqual(map, {
		tool0: { object: 'extruder', control: 'heater' },
		tool1: { object: 'extruder1', control: 'heater' },
		bed: { object: 'heater_bed', control: 'heater' },
		chamber: { object: 'temperature_fan chamber_fan', control: 'temperature_fan' }
	});
	assert.equal(parse.heaterMap(['heater_generic chamber', 'temperature_sensor chamber']).chamber.object, 'heater_generic chamber', 'a chamber heater beats a sensor');
	assert.equal(parse.heaterMap(['temperature_sensor Chamber']).chamber.control, null, 'a sensor has no target');
	const sub = parse.subscription(OBJECTS);
	assert.deepEqual(sub.extruder1, ['temperature', 'target']);
	assert.deepEqual(sub.fan, ['speed']);
	assert.ok(sub.print_stats?.includes('filename') && sub.virtual_sdcard?.includes('file_position'));
	assert.equal(sub.display_status, undefined, 'objects the printer lacks are left out');
	assert.equal(sub['temperature_sensor raspberry_pi'], undefined, 'other sensors are not charted');
});

test('state: Klippy states and print_stats map to printer states', () => {
	const ready = { state: 'ready', message: null };
	const st = (ps: string) => parse.stateFromStatus({ print_stats: { state: ps } }, ready);
	assert.equal(st('standby').state, 'operational');
	assert.equal(st('printing').state, 'printing');
	assert.equal(st('paused').state, 'paused');
	assert.equal(st('complete').state, 'operational');
	assert.equal(st('cancelled').state, 'operational');
	assert.deepEqual(st('error'), { state: 'operational', stateText: 'Ready (last print failed)', printerError: null });
	assert.deepEqual(parse.stateFromStatus({}, { state: 'shutdown', message: 'Lost communication with MCU' }), { state: 'error', stateText: 'Klipper shutdown', printerError: 'Lost communication with MCU' });
	assert.equal(parse.stateFromStatus({}, { state: 'startup', message: null }).state, 'connecting');
	assert.equal(parse.stateFromStatus({}, { state: 'disconnected', message: null }).state, 'disconnected');
	// webhooks (live) beats the last printer.info.
	assert.deepEqual(parse.klippyOf({ webhooks: { state: 'shutdown', state_message: 'M112' } }, ready), { state: 'shutdown', message: 'M112' });
});

test('snapshot: job, progress through the G-code body, slicer estimate, temps and Z', () => {
	const map = parse.heaterMap(['extruder', 'heater_bed']);
	const meta = parse.parseMeta({ size: 10_040, modified: 1_700_000_000, estimated_time: 3600, filament_total: 4200, gcode_start_byte: 40, gcode_end_byte: 10_040, thumbnails: [{ width: 32, height: 32, relative_path: '.thumbs/a-32.png' }, { width: 300, height: 300, relative_path: '.thumbs/a-300.png' }] }, 'parts/a.gcode');
	assert.equal(meta.thumbnail, 'parts/.thumbs/a-300.png', 'the largest thumbnail, relative to the gcodes root');
	const status = {
		print_stats: { state: 'printing', filename: 'parts/a.gcode', print_duration: 1200, total_duration: 1300 },
		virtual_sdcard: { progress: 0.5, file_position: 5040 },
		extruder: { temperature: 214.567, target: 215 },
		heater_bed: { temperature: 59.9, target: 60 },
		gcode_move: { gcode_position: [10, 20, 4.2, 100] }
	};
	const s = parse.snapshotFromStatus(status, { state: 'ready', message: null }, map, meta);
	assert.equal(s.state, 'printing');
	assert.deepEqual(s.job?.file, { name: 'a.gcode', path: 'parts/a.gcode', display: 'a.gcode', origin: 'local', size: 10_040, date: 1_700_000_000 });
	assert.equal(s.job?.estimatedPrintTime, 3600);
	assert.deepEqual(s.job?.filament, { tool0: { length: 4200, volume: null } });
	assert.equal(s.progress?.completion, 50, '(5040 - 40) / (10040 - 40)');
	assert.equal(s.progress?.printTime, 1300, 'elapsed including pauses');
	assert.equal(s.progress?.printTimeLeft, 2400, 'slicer estimate minus time printed');
	assert.equal(s.progress?.printTimeLeftOrigin, 'slicer');
	assert.deepEqual(s.temps, { tool0: { actual: 214.57, target: 215 }, bed: { actual: 59.9, target: 60 } });
	assert.equal(s.currentZ, 4.2);
	// No metadata: virtual_sdcard progress and a linear estimate.
	const lin = parse.progressFromStatus({ print_stats: { state: 'printing', filename: 'x.gcode', print_duration: 100, total_duration: 100 }, virtual_sdcard: { progress: 0.25, file_position: 10 } }, null);
	assert.deepEqual([lin?.completion, lin?.printTimeLeft, lin?.printTimeLeftOrigin], [25, 300, 'linear']);
	// Complete: 100 %, nothing left; no file: no job.
	assert.equal(parse.progressFromStatus({ print_stats: { state: 'complete', filename: 'x.gcode' }, virtual_sdcard: { progress: 0.99 } }, null)?.completion, 100);
	assert.equal(parse.snapshotFromStatus({ print_stats: { state: 'standby', filename: '' } }, { state: 'ready', message: null }, map, null).job, null);
	// Klipper down: no temps or job (they'd be stale).
	assert.deepEqual(parse.snapshotFromStatus(status, { state: 'shutdown', message: 'x' }, map, meta).temps, {});
});

test('status diffs merge per object; the temperature store becomes chart history', () => {
	const st = parse.mergeStatus({ extruder: { temperature: 20, target: 0 } }, { extruder: { target: 200 }, heater_bed: { temperature: 21 } });
	assert.deepEqual(st, { extruder: { temperature: 20, target: 200 }, heater_bed: { temperature: 21 } });
	const map = parse.heaterMap(['extruder', 'heater_bed']);
	const samples = parse.samplesFromStore({ extruder: { temperatures: [20, 30, 40], targets: [0, 200, 200] }, heater_bed: { temperatures: [21, 22], targets: [60, 60] } }, map, 10_000);
	assert.deepEqual(samples, [
		{ t: 8_000, v: { tool0: [20, 0] } },
		{ t: 9_000, v: { tool0: [30, 200], bed: [21, 60] } },
		{ t: 10_000, v: { tool0: [40, 200], bed: [22, 60] } }
	]);
});

test('print_stats changes become OctoPrint-style events (first sight is only a baseline)', () => {
	const tr = new parse.PrintTransitions();
	const ready = { state: 'ready', message: null };
	const at = (state: string, extra: Record<string, unknown> = {}) => tr.next({ print_stats: { state, filename: 'a/b.gcode', print_duration: 42, ...extra } }, ready).map((e) => e.name);
	assert.deepEqual(at('printing'), [], 'already printing when first seen: the detector infers the start');
	assert.deepEqual(at('paused'), ['PrintPaused']);
	assert.deepEqual(at('printing'), ['PrintResumed']);
	assert.deepEqual(at('complete'), ['PrintDone']);
	assert.deepEqual(at('standby'), []);
	assert.deepEqual(at('printing'), ['PrintStarted']);
	assert.deepEqual(at('cancelled'), ['PrintCancelled']);
	at('printing');
	const failed = tr.next({ print_stats: { state: 'error', filename: 'a/b.gcode', print_duration: 7 } }, ready);
	assert.deepEqual(failed, [{ name: 'PrintFailed', payload: { name: 'b.gcode', path: 'a/b.gcode', origin: 'local', time: 7, reason: 'error' } }]);
	at('printing');
	assert.deepEqual(tr.next({ print_stats: { state: 'printing' } }, { state: 'shutdown', message: 'M112' }).map((e) => [e.name, (e.payload as { reason: string }).reason]), [['PrintFailed', 'shutdown']], 'Klipper shutting down mid-print fails it');
});

test('files: directory listing → FileEntry, thumbnails stay inside the gcodes root', () => {
	const d = parse.directoryEntries(
		{
			dirs: [{ dirname: 'parts' }, { dirname: '.thumbs' }],
			files: [
				{ filename: 'benchy.gcode', size: 1234, modified: 1_700_000_000.7, estimated_time: 3600, filament_total: 4100, thumbnails: [{ width: 300, height: 300, relative_path: '.thumbs/benchy-300x300.png' }] },
				{ filename: 'notes.txt', size: 10, modified: 1 },
				{ filename: '.hidden.gcode', size: 1, modified: 1 }
			],
			disk_usage: { total: 100, used: 40, free: 60 }
		},
		'sub'
	);
	assert.deepEqual(d.dirs.map((x) => [x.path, x.type]), [['sub/parts', 'folder']], '.thumbs is hidden');
	assert.deepEqual(d.files.map((f) => [f.path, f.type, f.thumbnail]), [
		['sub/benchy.gcode', 'machinecode', 'sub/.thumbs/benchy-300x300.png'],
		['sub/notes.txt', 'other', null]
	]);
	assert.equal(d.files[0].date, 1_700_000_001);
	assert.equal(d.files[0].estimatedPrintTime, 3600);
	assert.equal(d.files[0].filamentMm, 4100);
	assert.deepEqual([d.free, d.total], [60, 100]);
	for (const bad of ['../moonraker.conf', 'a/../../x.png', 'x.cfg', '/etc/passwd', 'a\\b.png', '', null]) assert.equal(parse.safeThumbnailPath(bad), null, String(bad));
	assert.equal(parse.safeThumbnailPath('/.thumbs/a.png'), '.thumbs/a.png');
	assert.deepEqual(parse.fileDetailsFromMeta(parse.parseMeta({ size: 5, filament_total: 100, estimated_time: 60 })), { size: 5, filamentMm: 100, perTool: { 0: 100 }, estimatedS: 60, thumbnail: null, last: null });
});

test('controls: each action becomes the expected Klipper G-code', () => {
	assert.equal(parse.controlScript({ action: 'jog', x: 10, y: -1.5 }), 'G91\nG1 X10 Y-1.5 F6000\nG90');
	assert.equal(parse.controlScript({ action: 'jog', z: 0.1 }), 'G91\nG1 Z0.1 F600\nG90');
	assert.equal(parse.controlScript({ action: 'home', axes: ['x', 'y', 'z'] }), 'G28');
	assert.equal(parse.controlScript({ action: 'home', axes: ['z'] }), 'G28 Z');
	assert.equal(parse.controlScript({ action: 'feedrate', factor: 120 }), 'M220 S120');
	assert.equal(parse.controlScript({ action: 'flowrate', factor: 95 }), 'M221 S95');
	assert.equal(parse.controlScript({ action: 'fan', speed: 50 }), 'M106 S128');
	assert.equal(parse.controlScript({ action: 'fan', speed: 0 }), 'M107');
	assert.equal(parse.controlScript({ action: 'motors_off' }), 'M84');
	assert.equal(parse.controlScript({ action: 'tool', tool: 'tool1' }), 'ACTIVATE_EXTRUDER EXTRUDER=extruder1');
	assert.equal(parse.controlScript({ action: 'extrude', amount: -5 }), 'M83\nG1 E-5 F300');
	assert.equal(parse.controlScript({ action: 'extrude', amount: 10, tool: 'tool0' }), 'ACTIVATE_EXTRUDER EXTRUDER=extruder\nM83\nG1 E10 F300');
	assert.equal(parse.controlScript({ action: 'custom', name: 'x', commands: ['CLEAN', 'G28'] }), 'CLEAN\nG28');
	assert.throws(() => parse.controlScript({ action: 'custom', name: 'x', script: 'afterPrintCancelled' }), /macro/);
	const map = parse.heaterMap(['extruder', 'extruder1', 'heater_bed', 'temperature_fan chamber']);
	assert.equal(parse.targetScript('tool0', 210, map), 'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=210');
	assert.equal(parse.targetScript('tool1', 0, map), 'SET_HEATER_TEMPERATURE HEATER=extruder1 TARGET=0');
	assert.equal(parse.targetScript('bed', 60, map), 'SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=60');
	assert.equal(parse.targetScript('chamber', 45, map), 'SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=chamber TARGET=45');
	assert.throws(() => parse.targetScript('chamber', 45, parse.heaterMap(['extruder'])), /chamber heater/);
});

test('control info: macros as buttons, a profile from the Klipper config, Mainsail presets, webcams', () => {
	const macros = parse.macroControls(OBJECTS);
	assert.equal(macros.length, 1);
	assert.deepEqual(macros[0].kind === 'section' && macros[0].children.map((c) => c.kind === 'command' && c.commands), [['CLEAN'], ['PRINT_START']], '_HELPER stays hidden');
	const prof = parse.profileFromConfig({ printer: { kinematics: 'corexy', max_z_velocity: 5 }, stepper_x: { position_min: -5, position_max: 300 }, stepper_y: { position_max: 310 }, stepper_z: { position_max: 280 }, extruder: { nozzle_diameter: 0.6 } }, OBJECTS);
	assert.deepEqual(prof.volume, { width: 305, depth: 310, height: 280, formFactor: 'rectangular', origin: 'lowerleft' });
	assert.deepEqual([prof.extruders, prof.heatedBed, prof.heatedChamber, prof.nozzleDiameter, prof.axes.z.speed], [2, true, true, 0.6, 300]);
	const delta = parse.profileFromConfig({ printer: { kinematics: 'delta', print_radius: 100 }, stepper_z: { position_max: 300 } }, ['extruder']);
	assert.deepEqual(delta.volume, { width: 200, depth: 200, height: 300, formFactor: 'circular', origin: 'center' });
	const presets = parse.presetsFromMainsail({ value: { presets: { a: { name: 'PLA', values: { extruder: { bool: true, value: 215 }, heater_bed: { bool: true, value: 60 }, 'temperature_fan chamber': { bool: false, value: 40 } } } } } }, parse.heaterMap(['extruder', 'heater_bed', 'temperature_fan chamber']));
	assert.deepEqual(presets, [{ name: 'PLA', extruder: 215, bed: 60, chamber: null }]);
	const cams = parse.camerasFromWebcams({ webcams: [{ name: 'cam', service: 'mjpegstreamer', stream_url: '/webcam/?action=stream', snapshot_url: '/webcam/?action=snapshot', rotation: 90, flip_horizontal: true }, { name: 'rtc', service: 'webrtc-camerastreamer', stream_url: 'http://pi.lan/webcam/webrtc' }, { name: 'off', enabled: false, stream_url: '/x' }] }, 'http://voron.lan:7125');
	assert.deepEqual(cams.map((c) => [c.id, c.kind, c.streamUrl, c.snapshotUrl, c.rotate90, c.flipH]), [
		['cam', 'mjpeg', 'http://voron.lan/webcam/?action=stream', 'http://voron.lan/webcam/?action=snapshot', true, true],
		['rtc', 'webrtc', 'http://pi.lan/webcam/webrtc', null, false, false]
	], 'relative URLs belong to the web server, not Moonraker’s port');
	assert.equal(parse.webcamBase('https://print.example.com/moonraker'), 'https://print.example.com');
	assert.deepEqual(parse.logLines({ gcode_store: [{ message: 'G28', type: 'command' }, { message: 'ok\n// x', type: 'response' }] }), ['Send: G28', 'Recv: ok', 'Recv: // x']);
});

test('kind features: Klipper hides OctoPrint-only things, needs no key', () => {
	assert.deepEqual([...hiddenTabs({ kind: 'moonraker' })], ['timelapse', 'bed', 'plugins']);
	assert.deepEqual([...hiddenTabs({ kind: 'octoprint' })], []);
	assert.equal(features({ kind: 'moonraker' }).selectWithoutPrint, false);
	assert.ok(canReach({ kind: 'moonraker', hasApiKey: false }));
	assert.ok(!canReach({ kind: 'octoprint', hasApiKey: false }));
	assert.equal(websocketUrl('https://h:7125', 'a b'), 'wss://h:7125/websocket?token=a%20b');
});

// --- auto-detect and test connection ---------------------------------------------------------

test('auto-detect: Moonraker first (it emulates /api/version), then OctoPrint, else nothing', async () => {
	const r = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
	assert.equal(analyzeKind({ serverInfo: r(200, { result: { klippy_state: 'ready', moonraker_version: 'v0.9' } }), apiVersion: r(200, { server: '1.5.0', api: '0.1', text: 'OctoPrint (Moonraker v0.9)' }) }).kind, 'moonraker');
	assert.equal(analyzeKind({ serverInfo: r(401, { error: { code: 401, message: 'Unauthorized' } }), apiVersion: null }).kind, 'moonraker');
	assert.equal(analyzeKind({ serverInfo: r(404, { error: 'Not found' }), apiVersion: r(200, { server: '1.11.8', api: '0.1', text: 'OctoPrint 1.11.8' }) }).kind, 'octoprint');
	assert.equal(analyzeKind({ serverInfo: r(404, ''), apiVersion: r(403, { error: 'You don’t have the permission to access the requested resource.' }) }).kind, 'octoprint');
	assert.equal(analyzeKind({ serverInfo: r(200, '<html>'), apiVersion: r(200, '<html>') }).kind, null);
	assert.equal(analyzeKind({ serverInfo: null, apiVersion: null }).kind, null);

	assert.equal((await detectKind({ baseUrl: mr.url, apiKey: '', verifyTls: true })).kind, 'moonraker');
	assert.equal((await detectKind({ baseUrl: keyed.url, apiKey: '', verifyTls: true })).kind, 'moonraker', 'a 401 from /server/info still says Moonraker');
	const octo = createServer((req, res) => {
		if (req.url === '/api/version') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ server: '1.11.8', api: '0.1', text: 'OctoPrint 1.11.8' }));
		res.writeHead(404).end('nope');
	});
	await new Promise<void>((r) => octo.listen(PORTS.octo, '127.0.0.1', r));
	try {
		assert.equal((await detectKind({ baseUrl: `http://127.0.0.1:${PORTS.octo}`, apiKey: 'k', verifyTls: true })).kind, 'octoprint');
	} finally {
		octo.close();
	}
	assert.equal((await detectKind({ baseUrl: 'http://127.0.0.1:5559', apiKey: '', verifyTls: true }, 1_000)).kind, null, 'nothing listening');
});

test('test connection: versions, Klipper state notes, the key', async () => {
	const t = await testMoonraker({ baseUrl: mr.url, apiKey: '', verifyTls: true });
	assert.ok(t.ok);
	assert.equal(t.ok && t.kind, 'moonraker');
	assert.equal(t.ok && t.version, 'Klipper v0.12.0 · Moonraker v0.9.3');
	assert.ok(t.ok && t.notes?.some((n) => /trusted_clients/.test(n)));
	const bad = await testMoonraker({ baseUrl: keyed.url, apiKey: '', verifyTls: true });
	assert.ok(!bad.ok && /API key/.test(bad.error.message) && /trusted_clients/.test(bad.error.hint ?? ''));
	const good = await testPrinter({ baseUrl: keyed.url, apiKey: KEY, verifyTls: true, kind: 'auto' });
	assert.ok(good.ok && good.kind === 'moonraker');
	assert.ok(keyed.calls.some((c: { path?: string; key: string | null }) => c.path === '/server/info' && c.key === KEY), 'the key goes in X-Api-Key');
	const none = await testPrinter({ baseUrl: 'http://127.0.0.1:5559', apiKey: '', verifyTls: true, kind: 'auto' });
	assert.ok(!none.ok && none.error.code === 'ECONNREFUSED', 'unreachable: the network error, not "unknown server"');
});

// --- backend against the mock ----------------------------------------------------------------

test('backend: controls, temperatures and G-code become Klipper scripts; M112 uses emergency_stop', async () => {
	const b = new MoonrakerBackend(client());
	const sent: string[] = [];
	const logged = new MoonrakerBackend(client(), { onSent: (s) => sent.push(s) });
	mr.gcode.length = 0;
	await b.control({ action: 'home', axes: ['x', 'y', 'z'] });
	await b.control({ action: 'jog', x: 10 });
	await b.setTargets({ tool0: 200, bed: 55, chamber: 40 });
	await logged.sendCommands(['M105', 'STATUS']);
	assert.deepEqual(mr.gcode, ['G28', 'G91\nG1 X10 F6000\nG90', 'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200\nSET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=55\nSET_HEATER_TEMPERATURE HEATER=chamber TARGET=40', 'M105\nSTATUS']);
	assert.deepEqual(sent, ['M105\nSTATUS'], 'the terminal sees what octo·modern sent');
	assert.equal(mr.state.status.heater_bed.target, 55);
	const info = await b.controlInfo();
	assert.deepEqual([info.profile.volume.width, info.profile.volume.height, info.profile.heatedChamber], [250, 230, true]);
	assert.deepEqual(info.controls[0].kind === 'section' && info.controls[0].children.map((c) => c.name), ['CLEAN_NOZZLE', 'PREHEAT_PLA']);
	assert.deepEqual((await b.tempProfiles()).map((p) => [p.name, p.extruder, p.bed]), [['PLA', 215, 60], ['PETG', 240, 80]]);
	await b.setTargets({ tool0: 0, bed: 0, chamber: 0 });
	mr.calls.length = 0;
	await logged.sendCommands(['M112']);
	assert.ok(mr.calls.some((c: { path?: string }) => c.path === '/printer/emergency_stop'), 'M112 goes to printer.emergency_stop');
	assert.equal(mr.state.klippy, 'shutdown');
	assert.equal((await b.status()).state, 'error');
	await b.connect();
	assert.ok(mr.gcode.includes('FIRMWARE_RESTART'));
	await until(async () => (await b.status()).state === 'operational', 'Klipper back after a firmware restart');
});

test('backend: jobs (print, pause, resume, cancel, reprint), files, metadata, uploads, downloads', async () => {
	const b = new MoonrakerBackend(client());
	const listing = await b.files();
	assert.deepEqual(listing.files.map((f) => f.path), ['calibration', 'benchy.gcode', 'voron_cube_0.2mm_PLA.gcode']);
	assert.deepEqual(listing.files[0].children?.map((f) => f.path), ['calibration/first_layer.gcode']);
	assert.equal(listing.files[1].thumbnail, '.thumbs/benchy-300x300.png');
	assert.equal(listing.free, 22_000_000_000);
	const thumb = await b.thumbnail(b.thumbnailSource(listing.files[1].thumbnail)!);
	assert.equal(thumb.headers.get('content-type'), 'image/png');
	assert.equal((await thumb.arrayBuffer()).byteLength > 100, true);
	assert.equal(b.thumbnailSource('plugin/x/thumbnail/a.png?x'), null, 'OctoPrint plugin paths aren’t Klipper thumbnails');

	const details = await b.fileDetails('local', 'benchy.gcode');
	assert.deepEqual([details?.estimatedS, details?.filamentMm, details?.perTool, details?.thumbnail], [3720, 4210.5, { 0: 4210.5 }, '.thumbs/benchy-300x300.png']);
	assert.equal(await b.fileDetails('local', 'missing.gcode'), null);
	assert.equal(await b.fileSize('benchy.gcode'), mr.files.get('benchy.gcode').data.length);
	assert.equal(await b.fileSize('missing.gcode'), null);
	const part = await b.download('benchy.gcode', { headers: { range: 'bytes=0-9' } });
	assert.equal(part.status, 206);
	assert.equal(await part.text(), mr.files.get('benchy.gcode').data.subarray(0, 10).toString());

	await assert.rejects(b.selectFile('local', 'benchy.gcode', false), /without printing/);
	await b.selectFile('local', 'benchy.gcode', true);
	assert.deepEqual(await b.status().then((s) => [s.state, s.job?.file?.path]), ['printing', 'benchy.gcode']);
	await assert.rejects(b.selectFile('local', 'benchy.gcode', true), (e: { status?: number }) => e.status === 409, 'a print is already running: 409');
	await b.jobCommand('pause');
	assert.equal((await b.status()).state, 'paused');
	await b.jobCommand('resume');
	await b.jobCommand('cancel');
	assert.equal(mr.state.status.print_stats.state, 'cancelled');
	await b.jobCommand('restart');
	assert.equal(mr.state.status.print_stats.state, 'printing', 'restart reprints the last file');
	await b.jobCommand('cancel');

	// Upload: Moonraker's form fields go into the multipart body.
	const body = Buffer.from('G28\nG1 X1\n');
	const { head, tail, contentType } = multipartParts('new part.gcode');
	const stream = new Blob([head, body, tail]).stream();
	const r = await b.upload({ body: stream, contentType, length: head.length + body.length + tail.length, folder: 'calibration', print: true });
	assert.deepEqual(r, { path: 'calibration/new part.gcode', selected: true, printing: true });
	assert.equal(mr.state.status.print_stats.filename, 'calibration/new part.gcode');
	await b.jobCommand('cancel');
	await b.createFolder('jigs', 'calibration');
	assert.ok((await b.files()).files[0].children?.some((f) => f.path === 'calibration/jigs'));
	await b.deleteFile('local', 'calibration/new part.gcode');
	assert.ok(!mr.files.has('calibration/new part.gcode'));
	await b.deleteFile('local', 'calibration/jigs');
	assert.deepEqual((await b.cameras(mr.url)).map((c) => [c.label, c.kind]), [['Nozzle cam', 'mjpeg']]);
});

test('withFormFields prepends fields to any multipart body', async () => {
	const { head, tail, contentType } = multipartParts('a.gcode', 'BOUND');
	const src = new Blob([head, Buffer.from('X'), tail]).stream();
	const out = withFormFields(src, contentType, head.length + 1 + tail.length, { root: 'gcodes', print: 'true' });
	const text = await new Response(out.body).text();
	assert.ok(text.startsWith('--BOUND\r\nContent-Disposition: form-data; name="root"\r\n\r\ngcodes\r\n--BOUND\r\nContent-Disposition: form-data; name="print"\r\n\r\ntrue\r\n--BOUND\r\n'));
	assert.equal(Buffer.byteLength(text), out.length);
	assert.throws(() => withFormFields(new Blob([]).stream(), 'multipart/form-data', 0, {}), /boundary/);
});

// --- live: websocket and polling ----------------------------------------------------------------

test('live: the websocket subscribes, maps status, and turns a print into events; reconnects', async () => {
	const live = await startMockMoonraker({ port: PORTS.live, apiKey: KEY, tickMs: 40, printSeconds: 1 });
	const model = new LiveModel('p1', 30);
	const events: string[] = [];
	const logs: string[] = [];
	model.on((e) => {
		if (e.type === 'event') events.push(e.name);
		if (e.type === 'log') logs.push(...e.lines);
	});
	const c = client(live, KEY);
	const feed = new MoonrakerFeed(model, async (path) => (await c.get(`/server/files/metadata?filename=${encodeURIComponent(path)}`)) as unknown);
	const statuses: string[] = [];
	const session = new MoonrakerSession({
		url: async () => websocketUrl(c.target.baseUrl, await c.oneshotToken()),
		createSocket: (url) => openWebSocket(url, true),
		feed,
		backoff: () => 50,
		onStatus: (s) => statuses.push(s)
	});
	try {
		session.start();
		await until(() => session.open && model.snapshot.state === 'operational', 'websocket open and Klipper ready');
		assert.equal(model.snapshot.source, 'push');
		assert.equal(model.snapshot.version, 'Klipper v0.12.0 · Moonraker v0.9.3');
		assert.ok(model.snapshot.temps.tool0 && model.snapshot.temps.bed && model.snapshot.temps.chamber);
		assert.ok(live.calls.some((x: { via: string; args?: { token?: boolean } }) => x.via === 'ws' && x.args?.token), 'a one-shot token authenticates the socket');
		assert.ok(live.calls.some((x: { method?: string }) => x.method === 'server.connection.identify'));
		assert.ok(logs.includes('Recv: Klipper state: Ready'), 'the G-code store fills the terminal');

		const b = new MoonrakerBackend(c, { onSent: (s) => feed.sent(s) });
		await b.selectFile('local', 'benchy.gcode', true);
		await until(() => model.snapshot.state === 'printing' && model.snapshot.job?.estimatedPrintTime === 3720, 'printing, with the slicer estimate');
		assert.equal(model.snapshot.job?.file?.path, 'benchy.gcode');
		await b.jobCommand('pause');
		await until(() => model.snapshot.state === 'paused', 'paused');
		await b.jobCommand('resume');
		await until(() => events.includes('PrintDone'), 'print done', 8_000);
		assert.deepEqual(events.filter((e) => e.startsWith('Print')), ['PrintStarted', 'PrintPaused', 'PrintResumed', 'PrintDone']);
		assert.equal(model.snapshot.progress?.completion, 100);
		// Samples are taken about once a second; under load the print can finish in fewer, so wait for them.
		await until(() => model.history.toArray().length > 3, 'temperature samples accumulate', 8_000);

		await b.sendCommands(['M105']);
		await until(() => logs.some((l) => l.startsWith('Recv: ok T:')), 'the response arrives on the socket');
		assert.ok(logs.includes('Send: M105'));

		live.shutdown('MCU lost');
		await until(() => model.snapshot.state === 'error', 'Klipper shutdown shows as error');
		await b.connect();
		await until(() => model.snapshot.state === 'operational', 'ready again after a firmware restart', 8_000);

		live.dropSockets();
		await until(() => statuses.includes('waiting'), 'notices the drop');
		await until(() => session.open, 'reconnects');
	} finally {
		session.stop();
		await live.close();
	}
});

test('live: REST polling feeds the same model (and the same events)', async () => {
	const model = new LiveModel('p2', 30);
	const events: string[] = [];
	model.on((e) => e.type === 'event' && events.push(e.name));
	const c = client();
	const feed = new MoonrakerFeed(model, async () => null);
	await pollMoonraker(c, feed);
	assert.equal(model.snapshot.state, 'operational');
	assert.equal(model.snapshot.source, 'poll');
	assert.equal(feed.version, 'Klipper v0.12.0 · Moonraker v0.9.3');
	await new MoonrakerBackend(c).selectFile('local', 'voron_cube_0.2mm_PLA.gcode', true);
	await pollMoonraker(c, feed);
	assert.equal(model.snapshot.state, 'printing');
	await new MoonrakerBackend(c).jobCommand('cancel');
	await pollMoonraker(c, feed);
	assert.deepEqual(events, ['PrintStarted', 'PrintCancelled']);
	const unreachable = new MoonrakerClient({ baseUrl: 'http://127.0.0.1:5559', apiKey: '', verifyTls: true }, 1_000);
	await assert.rejects(pollMoonraker(unreachable, feed), /refused|reach/i);
});

// --- the app: stored printers, manager, history import ----------------------------------------

test('stored Klipper printer: backend, manager polling, OctoPrint-only features refused, history import', async () => {
	const m = await startMockMoonraker({ port: PORTS.manager, tickMs: 50 });
	try {
		const p = store.createPrinter({ name: 'Voron', kind: 'moonraker', baseUrl: m.url, verifyTls: true, webcamUrl: null, color: 'violet' });
		assert.equal(p.kind, 'moonraker');
		assert.equal(p.hasApiKey, false);
		assert.equal(backendFor(p).kind, 'moonraker');
		assert.throws(() => octoprintClient(p, 'Timelapse'), /isn’t available for Klipper/);
		const bedmesh = await import('../src/lib/server/bedmesh.ts');
		const before = m.calls.length;
		assert.equal((await bedmesh.detectPlugin(p.id)).installed, false, 'Bed Visualizer is OctoPrint-only');
		assert.equal(await bedmesh.pluginInstalled(p.id), false);
		assert.equal(m.calls.length, before, 'Moonraker isn’t asked about an OctoPrint plugin');
		assert.throws(() => octoprintClient(p, 'Bed mesh'), (e: { status?: number; code?: string }) => e.status === 400 && e.code === 'NOT_SUPPORTED');
		await printers.poll(p.id);
		assert.equal(printers.snapshot(p.id)?.state, 'operational');
		assert.equal(store.getPrinter(p.id)?.octoprintVersion, 'Klipper v0.12.0 · Moonraker v0.9.3');
		// Editing keeps the kind unless it's given.
		const edited = store.updatePrinter(p.id, { name: 'Voron 2.4', baseUrl: m.url, verifyTls: true, webcamUrl: null, color: 'cyan' });
		assert.equal(edited?.kind, 'moonraker');
		const r = await importHistory(store.getPrinter(p.id)!);
		assert.deepEqual([r.imported, r.sources], [2, ['Moonraker job history']]);
		assert.deepEqual((await importHistory(store.getPrinter(p.id)!)).imported, 0, 'idempotent');
		const o = store.createPrinter({ name: 'MK4', baseUrl: 'http://127.0.0.1:5559', apiKey: 'octo-key-123', verifyTls: true, webcamUrl: null, color: 'violet' });
		assert.equal(o.kind, 'octoprint', 'OctoPrint stays the default');
	} finally {
		await m.close();
	}
	const jobs = printsFromMoonrakerHistory([
		{ job_id: 'a', filename: 'x/y.gcode', status: 'klippy_shutdown', start_time: 100, end_time: 200, total_duration: 100, filament_used: 50 },
		{ job_id: 'b', filename: 'z.gcode', status: 'in_progress', start_time: 300 }
	]);
	assert.deepEqual(jobs.map((j) => [j.key, j.file, j.result, j.reason, j.startedAt, j.endedAt]), [['moonraker:a', 'y.gcode', 'failed', 'klippy_shutdown', 100_000, 200_000]]);
});

test('discovery: Moonraker fingerprint (it beats the /api/version emulation) and _moonraker._tcp candidates', async () => {
	const { analyzeFingerprint } = await import('../src/lib/server/discovery/fingerprint.ts');
	const { moonrakerCandidates, MDNS_TYPES } = await import('../src/lib/server/discovery/lan.ts');
	const fp = analyzeFingerprint({
		serverInfo: { status: 200, body: JSON.stringify({ result: { klippy_state: 'ready', moonraker_version: 'v0.9.3-1-gabc', api_version_string: '1.5.0' } }) },
		version: { status: 200, body: JSON.stringify({ server: '1.5.0', api: '0.1', text: 'OctoPrint (Moonraker v0.9.3)' }) }
	});
	assert.deepEqual([fp.kind, fp.confidence, fp.version, fp.loginRequired], ['moonraker', 'confirmed', 'v0.9.3', false]);
	const locked = analyzeFingerprint({ serverInfo: { status: 401, body: JSON.stringify({ error: { code: 401, message: 'Unauthorized' } }) } });
	assert.deepEqual([locked.kind, locked.loginRequired], ['moonraker', true]);
	assert.equal(analyzeFingerprint({ serverInfo: { status: 404, body: 'nope' }, version: { status: 200, body: JSON.stringify({ server: '1.11.8', api: '0.1', text: 'OctoPrint 1.11.8' }) } }).kind, undefined, 'OctoPrint stays OctoPrint');
	assert.equal(MDNS_TYPES.moonraker, '_moonraker._tcp.local');
	const [c] = await moonrakerCandidates(
		[{ instance: 'Moonraker Instance on voron', host: 'voron.local', port: 7125, addresses: ['192.0.2.10'], txt: {}, from: ['192.0.2.10'] }],
		{ probe: async (_h, p) => p === 7125, fingerprint: async () => fp }
	);
	assert.deepEqual([c.name, c.baseUrl, c.fingerprint.kind, c.source.ref], ['voron', 'http://192.0.2.10:7125', 'moonraker', 'moonraker:Moonraker Instance on voron']);
});
