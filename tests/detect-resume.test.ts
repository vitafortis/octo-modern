// Failure detection state survives a restart for the same print and is discarded for a
// different one. A restart is simulated with forgetRun() (drops the in-memory state only).
// Local mocks only: OctoPrint + webcam on 127.0.0.1:5120, ML API on :5121.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-detect-resume-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-detect-resume';
delete process.env.OCM_ML_API_URL;
delete process.env.OCM_ML_API_TOKEN;
delete process.env.OCM_DETECT_PUBLIC_URL;

const frames = await import('../src/lib/server/detect/frames.ts');
const settings = await import('../src/lib/server/detect/settings.ts');
const service = await import('../src/lib/server/detect/service.ts');
const runstate = await import('../src/lib/server/detect/runstate.ts');
const store = await import('../src/lib/server/store.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const { DETECT_DEFAULTS } = await import('../src/lib/detect.ts');

const OP_PORT = 5120;
const ML_PORT = 5121;

const op = { state: 'Printing' as 'Printing' | 'Paused' | 'Operational', printTime: 600, file: 'benchy.gcode', pauses: 0 };
const cam = new Uint8Array(jpeg.encode({ width: 320, height: 240, data: new Uint8Array(320 * 240 * 4).fill(90) }, 85).data);
let mlSeq: number[][] = [];
let mlCalls = 0;
let opServer: Server, mlServer: Server;
const listen = (s: Server, port: number) => new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));

before(async () => {
	opServer = createServer((req, res) => {
		const send = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
		const url = new URL(req.url!, 'http://x');
		if (url.pathname === '/api/version') return send({ api: '0.1', server: '1.11.2', text: 'OctoPrint 1.11.2' });
		if (url.pathname === '/api/printer') {
			const printing = op.state === 'Printing';
			const paused = op.state === 'Paused';
			return send({ state: { text: op.state, flags: { operational: true, printing, paused, pausing: false, resuming: false, cancelling: false, finishing: false, ready: !printing && !paused, error: false, closedOrError: false } }, temperature: { tool0: { actual: 215, target: 215 } } });
		}
		if (url.pathname === '/api/job' && req.method === 'GET') {
			const active = op.state !== 'Operational';
			return send({ job: { file: active ? { name: op.file, display: op.file, path: op.file, origin: 'local' } : { name: null }, estimatedPrintTime: 3600, filament: null }, progress: { completion: 20, printTime: active ? op.printTime : null, printTimeLeft: 3000, filepos: 1 }, state: op.state });
		}
		if (url.pathname === '/api/job' && req.method === 'POST') {
			op.pauses++;
			op.state = 'Paused';
			return res.writeHead(204).end();
		}
		if (url.pathname === '/snapshot') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(cam);
		res.writeHead(404).end();
	});
	mlServer = createServer((req, res) => {
		const url = new URL(req.url!, 'http://x');
		const token = new URL(url.searchParams.get('img')!).pathname.split('/').pop()!;
		frames.takeFrame(token);
		mlCalls++;
		const confs = mlSeq.shift() ?? [];
		res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ detections: confs.map((c, i) => ['failure', c, [100 + i * 60, 120, 50, 40]]) }));
	});
	await Promise.all([listen(opServer, OP_PORT), listen(mlServer, ML_PORT)]);
});

after(() => {
	for (const s of [opServer, mlServer]) {
		s.closeAllConnections();
		s.close();
	}
	for (const p of store.listPrinters()) printers.forget(p.id);
});

async function frame(id: string, now: number) {
	await printers.poll(id);
	await Promise.all(service.tick(now));
}

test('resumable: same file and history entry, or not restarted and started about the same time', () => {
	const saved = { path: 'a.gcode', printId: null, startedAt: 1_000_000, lastPrintTime: 600 };
	assert.ok(runstate.resumable(saved, { path: 'a.gcode', printId: null, printTime: 900, startedAt: 1_000_000 + 20_000 }));
	assert.ok(!runstate.resumable(saved, { path: 'b.gcode', printId: null, printTime: 900, startedAt: 1_000_000 }), 'another file');
	assert.ok(!runstate.resumable(saved, { path: 'a.gcode', printId: null, printTime: 30, startedAt: 1_000_000 }), 'the file was started again');
	assert.ok(!runstate.resumable(saved, { path: 'a.gcode', printId: null, printTime: 900, startedAt: 1_000_000 + 40 * 60_000 }), 'started much later');
	assert.ok(runstate.resumable({ ...saved, printId: 7 }, { path: 'a.gcode', printId: 7, printTime: 900, startedAt: 1_000_000 }));
	assert.ok(!runstate.resumable({ ...saved, printId: 7 }, { path: 'a.gcode', printId: 8, printTime: 900, startedAt: 1_000_000 }), 'another history entry');
});

test('service: score, alerts and a false-alarm mark carry on after a restart; a different print starts afresh', async () => {
	const p = store.createPrinter({ name: 'Resume MK4', baseUrl: `http://127.0.0.1:${OP_PORT}`, apiKey: 'op-key-12345', verifyTls: true, webcamUrl: `http://127.0.0.1:${OP_PORT}/snapshot`, color: 'violet' });
	settings.saveGlobal({ mlApiUrl: `http://127.0.0.1:${ML_PORT}`, token: 'ml-token', publicUrl: 'http://octo-modern:3000' });
	settings.savePrinterSettings(p.id, { ...DETECT_DEFAULTS, enabled: true, onFailure: 'pause', skipMinutes: 5, intervalS: 10 });

	// 12 quiet frames, then two that make it a warning.
	mlSeq = [...Array(12).fill([0.05]), [0.9, 0.9, 0.9], [0.9, 0.9, 0.9]];
	let t = Date.now();
	for (let i = 0; i < 14; i++) {
		await frame(p.id, (t += 10_000));
		op.printTime += 10;
	}
	let s = service.status(p.id, t);
	assert.equal(s.frames, 14);
	assert.equal(s.level, 'warning');
	assert.equal(s.events.filter((e) => e.kind === 'warning').length, 1);
	const saved = runstate.loadSavedRun(p.id);
	assert.equal(saved?.score.frames, 14, 'saved after every frame');
	assert.equal(saved?.warned, true);
	assert.equal(saved?.path, 'benchy.gcode');

	// Restart: same print. The score goes on from 14 frames, the warning isn't sent again, the history is kept.
	service.forgetRun();
	s = service.status(p.id, t);
	assert.equal(s.frames, 14, 'resumed');
	assert.equal(s.history.length, 14);
	mlSeq = [[0.9, 0.9, 0.9]];
	await frame(p.id, (t += 10_000));
	s = service.status(p.id, t);
	assert.equal(s.frames, 15);
	assert.equal(s.events.filter((e) => e.kind === 'warning').length, 1, 'no second warning');

	// Escalates to failure: paused once. After another restart it isn't paused again for this print.
	mlSeq = [[0.9, 0.9, 0.9]];
	op.printTime += 20;
	await frame(p.id, (t += 10_000));
	assert.equal(service.status(p.id, t).level, 'failure');
	assert.equal(op.pauses, 1);
	op.state = 'Printing'; // resumed by hand
	service.forgetRun();
	mlSeq = [[0.9, 0.9, 0.9], [0.9, 0.9, 0.9]];
	await frame(p.id, (t += 10_000));
	assert.equal(service.status(p.id, t).frames, 17);
	assert.equal(op.pauses, 1, 'failure already handled for this print');

	// A false alarm mark survives a restart too.
	service.dismiss(p.id, 'Ada');
	service.forgetRun();
	await frame(p.id, (t += 10_000));
	s = service.status(p.id, t);
	assert.equal(s.phase, 'dismissed');
	assert.equal(s.dismissed?.by, 'Ada');
	const calls = mlCalls;
	await frame(p.id, (t += 10_000));
	assert.equal(mlCalls, calls, 'still no frames');

	// Down while the print ended and another file started: the saved state is discarded.
	service.forgetRun();
	op.file = 'other.gcode';
	op.printTime = 400;
	mlSeq = [[0.1]];
	await frame(p.id, (t += 10_000));
	s = service.status(p.id, t);
	assert.equal(s.phase, 'watching');
	assert.equal(s.frames, 1, 'afresh');
	assert.equal(s.dismissed, null);
	assert.equal(s.events.length, 0);
	assert.equal(runstate.loadSavedRun(p.id)?.path, 'other.gcode');

	// The same file started again (print time went back): afresh as well.
	service.forgetRun();
	op.printTime = 320;
	mlSeq = [[0.1]];
	await frame(p.id, (t += 10_000));
	assert.equal(service.status(p.id, t).frames, 1);

	// The print ends: the saved state goes. Down while it ended: gone at the first look after the restart.
	op.state = 'Operational';
	await frame(p.id, (t += 10_000));
	assert.equal(runstate.loadSavedRun(p.id), null, 'cleared when the print ended');
	op.state = 'Printing';
	op.printTime = 400;
	await frame(p.id, (t += 10_000));
	assert.ok(runstate.loadSavedRun(p.id));
	service.forgetRun();
	op.state = 'Operational';
	await frame(p.id, (t += 10_000));
	assert.equal(runstate.loadSavedRun(p.id), null, 'cleared after a restart with the printer idle');
});
