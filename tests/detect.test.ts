import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-detect-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-detect';
delete process.env.OCM_ML_API_URL;
delete process.env.OCM_ML_API_TOKEN;
delete process.env.OCM_DETECT_PUBLIC_URL;

const score = await import('../src/lib/server/detect/score.ts');
const obico = await import('../src/lib/server/detect/obico.ts');
const frames = await import('../src/lib/server/detect/frames.ts');
const { annotateJpeg, jpegSize } = await import('../src/lib/server/detect/annotate.ts');
const settings = await import('../src/lib/server/detect/settings.ts');
const dnotify = await import('../src/lib/server/detect/notify.ts');
const service = await import('../src/lib/server/detect/service.ts');
const store = await import('../src/lib/server/store.ts');
const notify = await import('../src/lib/server/notify/settings.ts');
const nservice = await import('../src/lib/server/notify/service.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const { adminOnlyApi, controlApi } = await import('../src/lib/server/access.ts');
const { DETECT_DEFAULTS } = await import('../src/lib/detect.ts');

// Ports from this feature's range (3240–3249).
const OP_PORT = 3241;
const ML_PORT = 3242;
const HOOK_PORT = 3243;

const det = (confidence: number, box: [number, number, number, number] = [100, 80, 40, 30]) => ({ label: 'failure', confidence, box });

function grey(width = 320, height = 240): Uint8Array {
	const data = new Uint8Array(width * height * 4).fill(90);
	return new Uint8Array(jpeg.encode({ width, height, data }, 85).data);
}

// --- score: matches Obico's own code ------------------------------------------------------

test('score matches obico-server prediction.py + calc_normalized_p frame by frame', () => {
	// Reference values: obico-server backend/lib/prediction.py and failure_detection.py
	// (release, 6f93896) run on the same sequence: 12 frames of one 0.05 box, then 6
	// frames of three 0.9 boxes. [ewm, long, normalized, level]
	const expected: [number, number, number, string][] = [
		[0.007692, 0.025, 0, 'ok'],
		[0.014201, 0.033333, 0, 'ok'],
		[0.019709, 0.0375, 0, 'ok'],
		[0.024369, 0.04, 0, 'ok'],
		[0.028312, 0.041667, 0, 'ok'],
		[0.031649, 0.042857, 0, 'ok'],
		[0.034472, 0.04375, 0, 'ok'],
		[0.036861, 0.044444, 0, 'ok'],
		[0.038882, 0.045, 0, 'ok'],
		[0.040593, 0.045455, 0, 'ok'],
		[0.04204, 0.045833, 0, 'ok'],
		[0.043265, 0.046154, 0, 'ok'],
		[0.451993, 0.235714, 0.189718, 'ok'],
		[0.79784, 0.4, 0.354199, 'warning'],
		[1.09048, 0.54375, 0.52834, 'warning'],
		[1.338099, 0.670588, 0.669183, 'failure'],
		[1.547622, 0.783333, 0.766204, 'failure'],
		[1.724911, 0.884211, 0.842807, 'failure']
	];
	let s = score.newPrintScore();
	let b = score.newBaseline();
	const seq = [...Array(12).fill([det(0.05)]), ...Array(6).fill([det(0.9), det(0.9), det(0.9)])];
	seq.forEach((d, i) => {
		({ score: s, base: b } = score.addFrame(s, b, d));
		const a = score.assess(s, b, 1);
		const [ewm, long, n, level] = expected[i];
		assert.ok(Math.abs(s.ewm - ewm) < 1e-5, `frame ${i + 1} ewm ${s.ewm} vs ${ewm}`);
		assert.ok(Math.abs(b.long - long) < 1e-5, `frame ${i + 1} long ${b.long} vs ${long}`);
		assert.ok(Math.abs(a.score - n) < 1e-5, `frame ${i + 1} score ${a.score} vs ${n}`);
		assert.equal(a.level, level, `frame ${i + 1} level`);
	});
	assert.equal(s.frames, 18);
	assert.equal(b.frames, 18);
});

test('a long clean baseline makes the same spike a failure sooner; sensitivity scales it', () => {
	let s = score.newPrintScore();
	let b: { frames: number; long: number } = { frames: 5000, long: 0.02 };
	for (let i = 0; i < 60; i++) ({ score: s, base: b } = score.addFrame(s, b, [det(0.02)]));
	for (let i = 0; i < 4; i++) ({ score: s, base: b } = score.addFrame(s, b, [det(0.9), det(0.8)]));
	const normal = score.assess(s, b, 1);
	assert.equal(normal.level, 'failure');
	const dull = score.assess(s, b, 0.6);
	assert.ok(dull.score < normal.score);
	assert.equal(score.assess(score.newPrintScore(), score.newBaseline(), 1).level, 'ok');
	assert.equal(score.assess(score.newPrintScore(), score.newBaseline(), 1).score, 0);
	// Thresholds clamp to Obico's [0.38, 0.78] band.
	assert.equal(normal.warningThreshold >= 0.38 && normal.warningThreshold <= 0.78, true);
	assert.ok(Math.abs(normal.failureThreshold - normal.warningThreshold * 1.75) < 1e-9);
});

// --- ML API client -----------------------------------------------------------------------

test('predict URL, auth header and detection parsing follow ml_api/server.py', () => {
	assert.equal(obico.predictUrl('http://ml_api:3333/', 'http://octo:3000/api/detect/frame/abc?x=1'), 'http://ml_api:3333/p/?img=http%3A%2F%2Focto%3A3000%2Fapi%2Fdetect%2Fframe%2Fabc%3Fx%3D1');
	assert.deepEqual(obico.authHeaders('s3cret'), { authorization: 'Bearer s3cret' });
	assert.deepEqual(obico.authHeaders(null), {});
	const d = obico.parseDetections({ detections: [['failure', 0.71, [320.5, 200, 64, 48]], ['failure', 'x', [1, 2, 3, 4]], ['failure', 0.2, [1, 2, 3]], 'junk', ['failure', 1.7, [1, 2, 3, 4]]] });
	assert.deepEqual(d, [
		{ label: 'failure', confidence: 0.71, box: [320.5, 200, 64, 48] },
		{ label: 'failure', confidence: 1, box: [1, 2, 3, 4] }
	]);
	assert.deepEqual(obico.parseDetections({ detections: [] }), []);
	assert.throws(() => obico.parseDetections({ message: 'nope' }), /detections/);
});

// --- one-time frame links ------------------------------------------------------------------

test('frame tokens: unguessable, single use, short-lived', () => {
	const bytes = grey(16, 16);
	const t = frames.issueFrame('p1', bytes);
	assert.match(t, /^[A-Za-z0-9_-]{43}$/);
	const t2 = frames.issueFrame('p1', bytes);
	assert.notEqual(t2, t, 'fresh every time');
	frames.revokeFrame(t2);
	const f = frames.takeFrame(t);
	assert.equal(f?.printerId, 'p1');
	assert.equal(f?.bytes, bytes);
	assert.equal(frames.takeFrame(t), null, 'second use');
	const old = frames.issueFrame('p1', bytes, 'image/jpeg', 30_000, 1_000);
	assert.equal(frames.takeFrame(old, 31_001), null, 'expired');
	assert.equal(frames.pendingFrames(), 0);
	const revoked = frames.issueFrame('p1', bytes);
	frames.revokeFrame(revoked);
	assert.equal(frames.takeFrame(revoked), null, 'revoked');
	assert.equal(frames.takeFrame('../../etc/passwd'), null);
	assert.equal(frames.takeFrame(''), null);
	assert.equal(frames.frameUrl('http://octo:3000/', 'tok'), 'http://octo:3000/api/detect/frame/tok');
	// The route is outside every role rule: hooks.server.ts handles it before them.
	assert.equal(adminOnlyApi('GET', '/api/detect/frame/x'), false);
	assert.equal(controlApi('PUT', '/api/printers/abc/detect'), true, 'changing detection settings needs control');
	assert.equal(controlApi('POST', '/api/printers/abc/detect/dismiss'), true);
	assert.equal(controlApi('GET', '/api/printers/abc/detect'), false);
	assert.equal(adminOnlyApi('PUT', '/api/settings/detection'), true);
});

// --- annotation ------------------------------------------------------------------------------

test('annotation draws boxes above the visualization threshold only', () => {
	const src = grey(320, 240);
	assert.deepEqual(jpegSize(src), { width: 320, height: 240 });
	assert.equal(jpegSize(new Uint8Array([1, 2, 3, 4])), null);
	assert.equal(annotateJpeg(src, [det(0.1)]), src, 'nothing worth drawing: unchanged');
	const out = annotateJpeg(src, [det(0.9, [160, 120, 100, 80])]);
	assert.notEqual(out, src);
	const img = jpeg.decode(out, { useTArray: true });
	const px = (x: number, y: number) => Array.from(img.data.slice((y * 320 + x) * 4, (y * 320 + x) * 4 + 3));
	const [r, g, bl] = px(160, 81); // top edge of the box (y = 120 − 40)
	assert.ok(r > 180 && g < 120 && bl < 120, `red edge, got ${r},${g},${bl}`);
	const inside = px(160, 140);
	assert.ok(Math.abs(inside[0] - 90) < 12, 'inside untouched');
	assert.equal(annotateJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0]), [det(0.9)]).length, 4, 'undecodable: unchanged');
});

// --- settings --------------------------------------------------------------------------------

test('settings: validation, sealed token, env defaults', () => {
	assert.equal(settings.mlConfig(), null);
	assert.throws(() => settings.saveGlobal({ mlApiUrl: 'ftp://x' }), /http/);
	assert.throws(() => settings.saveGlobal({ mlApiUrl: 'http://u:p@x' }), /credentials/);
	assert.throws(() => settings.saveGlobal({ publicUrl: 'http://x/?a=1' }), /query/);
	const info = settings.saveGlobal({ mlApiUrl: 'http://ml_api:3333/', token: 'tok-123', publicUrl: 'http://octo-modern:3000' });
	assert.deepEqual(info, { mlApiUrl: 'http://ml_api:3333', hasToken: true, publicUrl: 'http://octo-modern:3000', fromEnv: { mlApiUrl: false, token: false, publicUrl: false } });
	assert.ok(!JSON.stringify(store.getKv('detect:settings', {})).includes('tok-123'), 'token sealed at rest');
	assert.deepEqual(settings.mlConfig(), { url: 'http://ml_api:3333', token: 'tok-123', publicUrl: 'http://octo-modern:3000' });
	settings.saveGlobal({ mlApiUrl: 'http://ml2:3333' }); // token left out: kept
	assert.equal(settings.mlConfig()?.token, 'tok-123');
	settings.saveGlobal({ token: null, mlApiUrl: null, publicUrl: null });
	process.env.OCM_ML_API_URL = 'http://env-ml:3333';
	process.env.OCM_DETECT_PUBLIC_URL = 'http://env-octo:3000';
	assert.deepEqual(settings.mlConfig(), { url: 'http://env-ml:3333', token: null, publicUrl: 'http://env-octo:3000' });
	assert.equal(settings.globalInfo().fromEnv.mlApiUrl, true);
	delete process.env.OCM_ML_API_URL;
	delete process.env.OCM_DETECT_PUBLIC_URL;

	const p = settings.parsePrinterSettings(DETECT_DEFAULTS, { enabled: true, sensitivity: 1.234, onFailure: 'pause', intervalS: 15, skipMinutes: 0 });
	assert.deepEqual(p, { enabled: true, sensitivity: 1.23, onFailure: 'pause', intervalS: 15, skipMinutes: 0 });
	assert.throws(() => settings.parsePrinterSettings(DETECT_DEFAULTS, { sensitivity: 3 }), /Sensitivity/);
	assert.throws(() => settings.parsePrinterSettings(DETECT_DEFAULTS, { intervalS: 1 }), /interval/);
	assert.throws(() => settings.parsePrinterSettings(DETECT_DEFAULTS, { onFailure: 'explode' }), /onFailure/);
	assert.throws(() => settings.parsePrinterSettings(DETECT_DEFAULTS, { enabled: 'yes' }), /enabled/);
	assert.deepEqual(settings.printerSettings('nope'), DETECT_DEFAULTS);
});

// --- notifications ----------------------------------------------------------------------------

test('failure notifications: an event with the annotated frame, routed like any other', async () => {
	const img = grey(8, 8);
	const ev = dnotify.failureEvent({ printer: { id: 'p1', name: 'Prusa MK4' }, file: 'benchy.gcode', info: { level: 'warning', score: 0.41, action: 'notify' }, frame: img, at: '2026-10-10T10:00:00.000Z' });
	assert.equal(ev.kind, 'failure.suspected');
	assert.equal(ev.severity, 'warning');
	assert.equal(ev.title, 'Failure suspected: Prusa MK4');
	assert.match(ev.message!, /benchy\.gcode.*41%/);
	assert.equal(ev.link, '/p/p1?tab=detection');
	assert.deepEqual((ev.snapshot as { data: Uint8Array }).data, img);
	assert.deepEqual(ev.data, { detection: { level: 'warning', score: 0.41, action: 'notify' } });
	const failure = dnotify.failureEvent({ printer: { id: 'p1', name: 'Prusa MK4' }, file: null, info: { level: 'failure', score: 0.8, action: 'paused' }, frame: null });
	assert.equal(failure.severity, 'error');
	assert.equal(failure.title, 'Print failure detected: Prusa MK4');
	assert.match(failure.message!, /octo·modern paused the print/);
	assert.equal(failure.snapshot, false);

	// Channels get them only when a rule routes failure.suspected to them.
	const c = notify.createChannel({ type: 'webhook', name: 'ends only', secrets: { url: 'http://127.0.0.1:9/x' } });
	notify.saveSettings({ rules: [{ name: 'ends', printers: 'all', events: ['print.failed'], channels: [c.id] }] });
	assert.equal(await dnotify.notifyFailure({ printer: { id: 'p1', name: 'Prusa MK4' }, file: null, info: { level: 'failure', score: 0.8, action: 'paused' }, frame: img }), 0);
	notify.deleteChannel(c.id);
});

// --- the service, against a mock OctoPrint and a mock ML API -----------------------------------

interface OpState {
	state: 'Printing' | 'Paused' | 'Operational';
	printTime: number;
	pauses: number;
}
const op: OpState = { state: 'Printing', printTime: 600, pauses: 0 };
const cam = grey(320, 240);
let mlSeq: number[][] = [];
const mlCalls: { auth: string | undefined; fetched: number; refetch: number }[] = [];
const hooks: Record<string, unknown>[] = [];
let opServer: Server, mlServer: Server, hookServer: Server;

const readBody = (req: IncomingMessage) => new Promise<string>((r) => {
	let b = '';
	req.on('data', (d) => (b += d));
	req.on('end', () => r(b));
});

const listen = (s: Server, port: number) => new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));

before(async () => {
	opServer = createServer(async (req, res) => {
		const send = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
		const url = new URL(req.url!, 'http://x');
		if (url.pathname === '/api/version') return send({ api: '0.1', server: '1.11.2', text: 'OctoPrint 1.11.2' });
		if (url.pathname === '/api/printer') {
			const printing = op.state === 'Printing';
			const paused = op.state === 'Paused';
			return send({ state: { text: op.state, flags: { operational: true, printing, paused, pausing: false, resuming: false, cancelling: false, finishing: false, ready: !printing && !paused, error: false, closedOrError: false } }, temperature: { tool0: { actual: 215, target: 215 }, bed: { actual: 60, target: 60 } } });
		}
		if (url.pathname === '/api/job' && req.method === 'GET') {
			const active = op.state !== 'Operational';
			return send({ job: { file: active ? { name: 'benchy.gcode', display: 'benchy.gcode', path: 'benchy.gcode', origin: 'local' } : { name: null }, estimatedPrintTime: 3600, filament: null, user: 'ada' }, progress: { completion: active ? 20 : null, printTime: active ? op.printTime : null, printTimeLeft: 3000, filepos: 1 }, state: op.state });
		}
		if (url.pathname === '/api/job' && req.method === 'POST') {
			const b = JSON.parse(await readBody(req));
			if (b.command === 'pause' && b.action === 'pause') {
				op.pauses++;
				op.state = 'Paused';
			}
			return res.writeHead(204).end();
		}
		if (url.pathname === '/snapshot') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(cam);
		send({ error: 'not found' }, 404);
	});
	mlServer = createServer(async (req, res) => {
		const url = new URL(req.url!, 'http://x');
		if (url.pathname === '/hc/') return res.end('ok');
		if (url.pathname !== '/p/') return res.writeHead(404).end();
		if (req.headers.authorization !== 'Bearer ml-token') return res.writeHead(401).end();
		const img = url.searchParams.get('img');
		if (!img) return res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ detections: [], message: 'Invalid request params' }));
		// Like ml_api: fetch the image by URL. There's no SvelteKit here, so resolve the
		// token the way the frame route does.
		const token = new URL(img).pathname.split('/').pop()!;
		const f = frames.takeFrame(token);
		const again = frames.takeFrame(token);
		mlCalls.push({ auth: req.headers.authorization, fetched: f?.bytes.length ?? 0, refetch: again?.bytes.length ?? 0 });
		if (!f) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ detections: [], message: 'Failed to get image' }));
		const confs = mlSeq.shift() ?? [];
		res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ detections: confs.map((c, i) => ['failure', c, [100 + i * 60, 120, 50, 40]]) }));
	});
	hookServer = createServer(async (req, res) => {
		hooks.push(JSON.parse(await readBody(req)));
		res.end('ok');
	});
	await Promise.all([listen(opServer, OP_PORT), listen(mlServer, ML_PORT), listen(hookServer, HOOK_PORT)]);
});

after(() => {
	for (const s of [opServer, mlServer, hookServer]) {
		s.closeAllConnections();
		s.close();
	}
	for (const p of store.listPrinters()) printers.forget(p.id);
});

async function frame(id: string, now: number) {
	await printers.poll(id);
	await Promise.all(service.tick(now));
}

test('service: frames while printing, warning notifies once, failure pauses (audited as the detector)', async () => {
	const p = store.createPrinter({ name: 'Prusa MK4', baseUrl: `http://127.0.0.1:${OP_PORT}`, apiKey: 'op-key-12345', verifyTls: true, webcamUrl: `http://127.0.0.1:${OP_PORT}/snapshot`, color: 'violet' });
	settings.saveGlobal({ mlApiUrl: `http://127.0.0.1:${ML_PORT}`, token: 'ml-token', publicUrl: 'http://octo-modern:3000' });
	const hook = notify.createChannel({ type: 'webhook', name: 'hook', config: { includeImage: true }, secrets: { url: `http://127.0.0.1:${HOOK_PORT}/f` } });
	notify.saveSettings({ rules: [{ name: 'detections', printers: 'all', events: ['failure.suspected'], channels: [hook.id] }] });
	nservice.limiter.reset();

	// Off by default: nothing happens.
	await frame(p.id, Date.now());
	assert.equal(mlCalls.length, 0);
	assert.equal(service.status(p.id).phase, 'off');

	settings.savePrinterSettings(p.id, { ...DETECT_DEFAULTS, enabled: true, onFailure: 'pause', skipMinutes: 15 });
	await frame(p.id, Date.now());
	assert.equal(mlCalls.length, 0, 'within the first 15 minutes (print time 600 s)');
	assert.equal(service.status(p.id).phase, 'waiting');

	settings.savePrinterSettings(p.id, { ...DETECT_DEFAULTS, enabled: true, onFailure: 'pause', skipMinutes: 5, intervalS: 10 });
	mlSeq = [...Array(12).fill([0.05]), ...Array(6).fill([0.9, 0.9, 0.9])];
	let t = Date.now();
	for (let i = 0; i < 12; i++) {
		await frame(p.id, (t += 10_000));
		op.printTime += 10;
	}
	let s = service.status(p.id, t);
	assert.equal(s.phase, 'watching');
	assert.equal(s.frames, 12);
	assert.equal(s.level, 'ok');
	assert.equal(mlCalls.length, 12);
	assert.ok(mlCalls.every((c) => c.auth === 'Bearer ml-token' && c.fetched === cam.length && c.refetch === 0), 'each frame fetched once with the bearer token; a second fetch gets nothing');
	assert.equal(frames.pendingFrames(), 0, 'no links left behind');

	// Ticking again before the interval does nothing.
	await frame(p.id, t + 3_000);
	assert.equal(mlCalls.length, 12);

	for (let i = 0; i < 2; i++) await frame(p.id, (t += 10_000));
	s = service.status(p.id, t);
	assert.equal(s.level, 'warning');
	assert.equal(hooks.length, 1, 'one warning notification');
	assert.equal((hooks[0] as { data: { detection: { level: string } } }).data.detection.level, 'warning');
	assert.ok(((hooks[0] as { image: { base64: string } }).image.base64.length) > 100, 'annotated frame attached');
	assert.ok(s.last && s.last.boxes.length === 3 && s.last.width === 320);
	assert.ok(Math.abs(s.last.boxes[0].box[0] - 100 / 320) < 1e-9, 'boxes as fractions of the frame');
	assert.equal(service.lastFrame(p.id)?.[0], 0xff);

	await frame(p.id, (t += 10_000)); // still warning: no second notification
	assert.equal(hooks.length, 1);
	await frame(p.id, (t += 10_000)); // failure
	s = service.status(p.id, t);
	assert.equal(s.level, 'failure');
	assert.equal(op.pauses, 1, 'paused once');
	assert.equal(hooks.length, 2);
	assert.equal((hooks[1] as { data: { detection: { action: string } } }).data.detection.action, 'paused');
	const audit = store.searchAudit({ action: 'job.pause' });
	assert.equal(audit.length, 1);
	assert.equal(audit[0].userEmail, 'octo·modern detector');
	assert.equal(audit[0].userId, null);
	assert.match(audit[0].detail ?? '', /benchy\.gcode: failure score \d+%/);
	assert.ok(s.events.some((e) => e.kind === 'paused'));

	// Paused: no more frames.
	await frame(p.id, (t += 10_000));
	assert.equal(service.status(p.id, t).phase, 'paused');
	assert.equal(mlCalls.length, 16);

	// Resumed: a false alarm switches it off for the rest of this print.
	op.state = 'Printing';
	const d = service.dismiss(p.id, 'Ada');
	assert.equal(d.phase, 'dismissed');
	await frame(p.id, (t += 10_000));
	assert.equal(mlCalls.length, 16, 'no frames after a false alarm');

	// The print ends; the next one starts afresh and watching resumes.
	op.state = 'Operational';
	await frame(p.id, (t += 10_000));
	assert.equal(service.status(p.id, t).phase, 'idle');
	assert.throws(() => service.dismiss(p.id, 'Ada'), /isn’t printing/);
	op.state = 'Printing';
	op.printTime = 400;
	mlSeq = [[0.1]];
	await frame(p.id, (t += 10_000));
	s = service.status(p.id, t);
	assert.equal(s.phase, 'watching');
	assert.equal(s.frames, 1);
	assert.equal(s.dismissed, null);
	assert.ok(settings.loadBaseline(p.id).frames >= 17, 'the baseline carries over between prints');
});

test('service: ML API errors are reported, not thrown', async () => {
	const p = store.listPrinters()[0];
	settings.saveGlobal({ token: 'wrong' });
	await frame(p.id, Date.now() + 10 * 60_000);
	const s = service.status(p.id);
	assert.match(s.error ?? '', /401/);
	assert.ok(s.events.some((e) => e.kind === 'error'));
	assert.equal(frames.pendingFrames(), 0, 'link revoked after a failed call');
	settings.saveGlobal({ mlApiUrl: 'http://127.0.0.1:9' });
	assert.equal((await obico.health('http://127.0.0.1:9')).ok, false);
	assert.equal((await obico.health(`http://127.0.0.1:${ML_PORT}`)).ok, true);
	await assert.rejects(obico.predict({ url: `http://127.0.0.1:${ML_PORT}`, token: 'ml-token' }, 'http://x/api/detect/frame/missing'), /400.*download the frame/);
});
