// End-to-end test against real OctoPrint servers (virtual printers in Docker).
//
//   pnpm e2e                  # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e       # leave the containers and app running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e # reuse ./build
//
// Needs Docker and a Playwright Chromium (`pnpm exec playwright install chromium`).
// Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMjpegSource } from '../mjpeg-source.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3041);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_BASE = Number(process.env.E2E_OP_PORT_BASE ?? 5111);
const OP_PREFIX = process.env.E2E_OP_PREFIX ?? 'octo-modern-e2e-op';
const CAM_PORT = Number(process.env.E2E_CAM_PORT ?? 5191);
const CAM = `http://127.0.0.1:${CAM_PORT}`;
const OP = [1, 2].map((i) => ({ url: `http://127.0.0.1:${OP_BASE + i - 1}`, key: `ocm-dev-key-${i}` }));
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const opEnv = { ...process.env, OCM_OP_PORT_BASE: String(OP_BASE), OCM_OP_PREFIX: OP_PREFIX };
const devOctoprint = (...args) => execFileSync(join(ROOT, 'scripts/dev-octoprint.sh'), args, { env: { ...opEnv, ...(args[0] === 'up' ? { OCM_OP_CONNECT: '0' } : {}) }, stdio: 'inherit' });

let app;
let browser;
let cam;
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-'));

async function waitFor(fn, label, { tries = 60, every = 500 } = {}) {
	let last;
	for (let i = 0; i < tries; i++) {
		try {
			const v = await fn();
			if (v) return v;
		} catch (err) {
			last = err;
		}
		await sleep(every);
	}
	throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

/** A tiny cookie-keeping JSON client for one user. */
function client() {
	let cookie = '';
	const call = async (method, path, body, { raw = false } = {}) => {
		const res = await fetch(`${APP}${path}`, {
			method,
			redirect: 'manual',
			headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), origin: APP },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const set = res.headers.get('set-cookie');
		if (set) cookie = set.split(';')[0];
		if (raw) return res;
		const data = await res.json().catch(() => null);
		return { status: res.status, data };
	};
	return {
		get: (p, o) => call('GET', p, undefined, o),
		post: (p, b, o) => call('POST', p, b ?? {}, o),
		put: (p, b) => call('PUT', p, b),
		del: (p) => call('DELETE', p, {}),
		get cookie() {
			return cookie;
		}
	};
}

/** Reads an SSE stream until `until(events)` is true. */
async function sse(c, path, until, timeoutMs = 20_000) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	const res = await fetch(`${APP}${path}`, { headers: { cookie: c.cookie }, signal: ctrl.signal });
	assert.equal(res.status, 200, `SSE ${path}`);
	assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
	const events = [];
	const decoder = new TextDecoder();
	let buf = '';
	try {
		for await (const chunk of res.body) {
			buf += decoder.decode(chunk, { stream: true });
			let i;
			while ((i = buf.indexOf('\n\n')) !== -1) {
				const block = buf.slice(0, i);
				buf = buf.slice(i + 2);
				const ev = /^event: (.+)$/m.exec(block)?.[1];
				const data = /^data: (.+)$/m.exec(block)?.[1];
				if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
			}
			if (until(events)) break;
		}
	} finally {
		clearTimeout(timer);
		ctrl.abort();
	}
	if (!until(events)) throw new Error(`SSE ended before the condition held (${events.length} events)`);
	return events;
}

/** G-code that keeps the virtual printer busy for ~2 minutes (dwells between short moves). */
function slowGcode() {
	const lines = ['; octo-modern e2e print', 'G21', 'G90', 'M82', 'G28', 'G1 Z0.2 F600'];
	for (let layer = 1; layer <= 20; layer++) {
		lines.push(`G1 Z${(layer * 0.2).toFixed(2)} F600`);
		for (let i = 0; i < 24; i++) {
			const a = (i / 24) * Math.PI * 2;
			lines.push(`G1 X${(100 + 15 * Math.cos(a)).toFixed(2)} Y${(100 + 15 * Math.sin(a)).toFixed(2)} E${(layer + i * 0.04).toFixed(3)} F1800`);
			if (i % 4 === 0) lines.push('G4 P120');
		}
	}
	lines.push('M104 S0', 'M140 S0', 'M84');
	return lines.join('\n') + '\n';
}

/** Uploads a file to OctoPrint directly (as a slicer would), optionally selecting it. */
async function uploadToOctoPrint(op, name, content, { select = false } = {}) {
	const fd = new FormData();
	fd.set('file', new Blob([content]), name);
	if (select) fd.set('select', 'true');
	const res = await fetch(`${op.url}/api/files/local`, { method: 'POST', headers: { 'X-Api-Key': op.key }, body: fd });
	assert.equal(res.status, 201, `upload to OctoPrint: ${await res.text()}`);
}

/** Uploads through octo·modern (multipart, streamed to OctoPrint), as the browser does. */
async function uploadViaApp(c, printerId, name, content, query = {}) {
	const fd = new FormData();
	fd.set('file', new Blob([content]), name);
	const q = new URLSearchParams({ name, ...query });
	const res = await fetch(`${APP}/api/printers/${printerId}/files/upload?${q}`, { method: 'POST', headers: { cookie: c.cookie, origin: APP }, body: fd });
	return { status: res.status, data: await res.json().catch(() => null) };
}

/** Streams a large multipart upload from a generator (known length, never in memory), sampling the app's memory meanwhile. */
async function bigUpload(c, printerId, name, megabytes) {
	const boundary = `----ocm${Date.now()}`;
	const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
	const chunk = Buffer.from('; padding line for a large upload test '.padEnd(1023, 'x') + '\n');
	const chunks = megabytes * 1024;
	let i = -1;
	const body = new ReadableStream({
		pull(ctrl) {
			if (i === -1) ctrl.enqueue(head);
			else if (i < chunks) ctrl.enqueue(i === 0 ? Buffer.from('G28\nG1 X10 Y10\n'.padEnd(1024, ';') ) : chunk);
			else {
				ctrl.enqueue(tail);
				ctrl.close();
			}
			i++;
		}
	});
	const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(app.pid)]).toString().trim()) * 1024;
	const before = rss();
	let peak = before;
	const sampler = setInterval(() => (peak = Math.max(peak, rss())), 200);
	const res = await fetch(`${APP}/api/printers/${printerId}/files/upload?name=${name}`, {
		method: 'POST',
		headers: { cookie: c.cookie, origin: APP, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(head.length + chunks * 1024 + tail.length) },
		body,
		duplex: 'half'
	});
	clearInterval(sampler);
	return { status: res.status, data: await res.json().catch(() => null), growth: peak - before };
}

async function opState(op) {
	const r = await fetch(`${op.url}/api/job`, { headers: { 'X-Api-Key': op.key } });
	return (await r.json()).state;
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting two OctoPrint servers with virtual printers');
	devOctoprint('up', '2');
	// The second one is connected by the harness; the first is connected through octo·modern below.
	await fetch(`${OP[1].url}/api/connection`, {
		method: 'POST',
		headers: { 'X-Api-Key': OP[1].key, 'content-type': 'application/json' },
		body: JSON.stringify({ command: 'connect', port: 'VIRTUAL', baudrate: 0 })
	});

	cam = await startMjpegSource({ port: CAM_PORT, host: '127.0.0.1' });
	log(`MJPEG test camera on ${CAM}`);

	if (!process.env.E2E_SKIP_BUILD) {
		log('building');
		execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'ignore' });
	}
	log(`starting octo·modern on ${APP}`);
	app = spawn('node', ['build'], {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', OCM_DATA_DIR: dataDir, OCM_POLL_INTERVAL_MS: '3000', BODY_SIZE_LIMIT: '4G', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' }
	});
	let appLog = '';
	app.stdout.on('data', (d) => (appLog += d));
	app.stderr.on('data', (d) => (appLog += d));
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');

	// --- setup and servers -------------------------------------------------------------
	const admin = client();
	assert.equal((await admin.get('/api/printers')).status, 401, 'setup required before anything else');
	assert.equal((await admin.post('/api/auth/setup', { email: 'x', password: 'short' })).status, 400);
	assert.equal((await admin.post('/api/auth/setup', ADMIN)).status, 200, 'setup wizard creates the admin');
	assert.equal((await client().post('/api/auth/setup', { ...ADMIN, email: 'other@example.com' })).status, 409, 'setup only works once');

	log('testing connections');
	const good = (await admin.post('/api/printers/test', { baseUrl: OP[0].url, apiKey: OP[0].key })).data;
	assert.equal(good.ok, true);
	assert.match(good.version, /^1\./);
	assert.equal(good.user, 'admin');
	const badKey = (await admin.post('/api/printers/test', { baseUrl: OP[0].url, apiKey: 'definitely-wrong-key' })).data;
	assert.equal(badKey.ok, false);
	assert.equal(badKey.error.code, 'HTTP_403');
	assert.match(badKey.error.hint, /Application Key/);
	const refused = (await admin.post('/api/printers/test', { baseUrl: 'http://127.0.0.1:5199', apiKey: 'x-x-x-x-x' })).data;
	assert.equal(refused.error.code, 'ECONNREFUSED');

	log('adding the first server');
	const p1 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: OP[0].url, apiKey: OP[0].key, color: 'violet', webcamUrl: `${CAM}/?action=stream` })).data;
	assert.ok(p1.id && p1.hasApiKey && !JSON.stringify(p1).includes(OP[0].key), 'the key is never sent back');
	const root = await admin.get('/', { raw: true });
	assert.equal(root.status, 307, 'one printer: / goes straight to it');
	assert.equal(root.headers.get('location'), `/p/${p1.id}`);

	// --- connect, live temps over SSE, set a temperature ---------------------------------
	log('connecting the printer through octo·modern');
	const conn = (await admin.get(`/api/printers/${p1.id}/connection`)).data;
	assert.ok(conn.options.ports.includes('VIRTUAL'));
	assert.equal((await admin.post(`/api/printers/${p1.id}/connection`, { command: 'connect', port: 'VIRTUAL', baudrate: 115200 })).status, 200);
	await waitFor(async () => (await admin.get('/api/printers/status')).data.find((s) => s.id === p1.id)?.state === 'operational', 'operational');

	log('live temperatures over SSE, then setting a target');
	const livePush = (e) => e.event === 'update' && e.data.snapshot.source === 'push' && e.data.samples.length > 0;
	const first = await sse(admin, `/api/printers/${p1.id}/events`, (ev) => ev.some(livePush));
	assert.equal(first[0].event, 'snapshot', 'the stream starts with a full snapshot');
	assert.ok(first.find(livePush).data.snapshot.temps.tool0, 'hotend temperature arrives');
	const [heat] = await Promise.all([
		sse(admin, `/api/printers/${p1.id}/events`, (ev) => ev.some((e) => e.event === 'update' && e.data.snapshot.temps.tool0?.target === 60 && e.data.snapshot.temps.tool0.actual > 30)),
		sleep(800).then(() => admin.post(`/api/printers/${p1.id}/temperature`, { targets: { tool0: 60, bed: 40 } }))
	]);
	assert.ok(heat.length > 1);
	assert.equal((await admin.post(`/api/printers/${p1.id}/temperature`, { targets: { tool0: 999 } })).status, 400, 'out-of-range targets are refused');
	const profiles = (await admin.get(`/api/printers/${p1.id}/profiles`)).data.profiles;
	assert.deepEqual(profiles.map((p) => p.name), ['PLA', 'PETG', 'ABS']);

	// --- users and roles -------------------------------------------------------------------
	log('roles: operator controls, viewer watches');
	for (const u of [
		{ ...OPERATOR, role: 'operator' },
		{ ...VIEWER, role: 'viewer' }
	]) assert.equal((await admin.post('/api/users', u)).status, 201);
	const operator = client();
	const viewer = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);
	assert.equal((await viewer.get('/api/printers/status')).data.length, 1, 'viewers see the printer');
	assert.equal((await viewer.post(`/api/printers/${p1.id}/temperature`, { targets: { bed: 0 } })).status, 403, 'viewers can’t control');
	assert.equal((await viewer.post(`/api/printers/${p1.id}/job`, { command: 'start' })).status, 403);
	assert.equal((await operator.post('/api/printers', { baseUrl: OP[1].url, apiKey: OP[1].key })).status, 403, 'operators can’t add servers');
	assert.equal((await operator.get('/api/users')).status, 403);
	assert.equal((await viewer.get(`/api/printers/${p1.id}`)).data.access.control, false);
	assert.ok(!JSON.stringify((await viewer.get(`/api/printers/${p1.id}`)).data).includes(OP[0].key));

	// --- files and a print: upload, start, pause, resume, cancel -----------------------
	log('files: a slicer upload to OctoPrint shows up in the listing');
	await uploadToOctoPrint(OP[0], 'from-slicer.gcode', slowGcode());
	const listed = await waitFor(async () => {
		const l = (await viewer.get(`/api/printers/${p1.id}/files`)).data;
		return l.files.find((f) => f.name === 'from-slicer.gcode' && f.estimatedPrintTime > 0) && l;
	}, 'the analysed file in the listing');
	assert.ok(listed.free > 0);
	assert.equal((await uploadViaApp(viewer, p1.id, 'nope.gcode', 'G28\n')).status, 403, 'viewers can’t upload');
	assert.equal((await viewer.del(`/api/printers/${p1.id}/files?origin=local&path=from-slicer.gcode&confirm=1`)).status, 403, 'viewers can’t delete');

	log('upload & print through octo·modern, then pause, resume and cancel');
	const up = await uploadViaApp(operator, p1.id, 'e2e-ring.gcode', slowGcode(), { print: '1' });
	assert.equal(up.status, 201, `${up.status} ${JSON.stringify(up.data)}`);
	assert.equal(up.data.printing, true, 'upload & print starts the job');
	await waitFor(async () => (await opState(OP[0])).startsWith('Printing'), 'printing');
	const gcodeWhilePrinting = await operator.post(`/api/printers/${p1.id}/command`, { commands: ['M105'] });
	assert.equal(gcodeWhilePrinting.status, 409, 'G-code while printing needs confirming');
	assert.equal(gcodeWhilePrinting.data.confirmRequired, true);
	assert.equal((await operator.post(`/api/printers/${p1.id}/command`, { commands: ['M105'], confirm: true })).status, 200);
	assert.equal((await operator.post(`/api/printers/${p1.id}/job`, { command: 'pause' })).status, 200);
	await waitFor(async () => (await opState(OP[0])) === 'Paused', 'paused');
	assert.equal((await operator.post(`/api/printers/${p1.id}/job`, { command: 'resume' })).status, 200);
	await waitFor(async () => (await opState(OP[0])).startsWith('Printing'), 'printing again');
	const busyDelete = await operator.del(`/api/printers/${p1.id}/files?origin=local&path=e2e-ring.gcode&confirm=1`);
	assert.equal(busyDelete.status, 409, 'a file being printed can’t be deleted');
	const cancelNoConfirm = await operator.post(`/api/printers/${p1.id}/job`, { command: 'cancel' });
	assert.equal(cancelNoConfirm.status, 409, 'cancel needs confirming');
	assert.equal((await operator.post(`/api/printers/${p1.id}/job`, { command: 'cancel', confirm: true })).status, 200);
	await waitFor(async () => (await opState(OP[0])) === 'Operational', 'cancelled');

	log('select & print an existing file, folders, and delete with confirmation');
	assert.equal((await operator.post(`/api/printers/${p1.id}/files/select`, { origin: 'local', path: 'from-slicer.gcode', print: true })).status, 200);
	await waitFor(async () => (await opState(OP[0])).startsWith('Printing'), 'printing the selected file');
	assert.equal((await operator.post(`/api/printers/${p1.id}/job`, { command: 'cancel', confirm: true })).status, 200);
	await waitFor(async () => (await opState(OP[0])) === 'Operational', 'cancelled again');
	assert.equal((await operator.post(`/api/printers/${p1.id}/files/folder`, { name: 'Calibration', parent: '' })).status, 201);
	assert.equal((await uploadViaApp(operator, p1.id, 'cube.gcode', 'G28\nG1 X10\n', { path: 'Calibration' })).status, 201);
	const nested = (await operator.get(`/api/printers/${p1.id}/files`)).data.files.find((f) => f.name === 'Calibration');
	assert.deepEqual(nested.children.map((c) => c.path), ['Calibration/cube.gcode']);
	const noConfirm = await operator.del(`/api/printers/${p1.id}/files?origin=local&path=from-slicer.gcode`);
	assert.equal(noConfirm.status, 409, 'deleting needs confirming');
	assert.equal((await operator.del(`/api/printers/${p1.id}/files?origin=local&path=from-slicer.gcode&confirm=1`)).status, 200);
	assert.ok(!(await operator.get(`/api/printers/${p1.id}/files`)).data.files.some((f) => f.name === 'from-slicer.gcode'));

	log('a 200 MB upload streams through without buffering');
	const big = await bigUpload(operator, p1.id, 'big-upload.gcode', 200);
	assert.equal(big.status, 201, JSON.stringify(big.data));
	log(`  app memory grew by ${(big.growth / 1048576).toFixed(1)} MB during the upload`);
	assert.ok(big.growth < 64 * 1048576, `memory grew ${big.growth} bytes`);
	const bigFile = (await operator.get(`/api/printers/${p1.id}/files`)).data.files.find((f) => f.name === 'big-upload.gcode');
	assert.ok(bigFile.size > 200 * 1048576 * 0.99, 'OctoPrint got the whole file');
	assert.equal((await operator.del(`/api/printers/${p1.id}/files?origin=local&path=big-upload.gcode&confirm=1`)).status, 200);

	log('audit log records each action with its user');
	const audit = (await admin.get('/api/audit?limit=200')).data;
	for (const action of ['printer.create', 'printer.connect', 'temperature.set', 'job.start', 'job.pause', 'job.resume', 'job.cancel', 'gcode.send', 'user.create', 'file.upload', 'file.delete', 'file.folder']) {
		assert.ok(audit.some((e) => e.action === action), action);
	}
	assert.equal(audit.find((e) => e.action === 'job.cancel').userEmail, OPERATOR.email);
	assert.equal(audit.find((e) => e.action === 'job.cancel').printerName, 'Prusa MK4');

	// --- second server, overview, status API ---------------------------------------------
	log('adding a second server; the overview lists both');
	const p2 = (await admin.post('/api/printers', { name: 'Voron 2.4', baseUrl: OP[1].url, apiKey: OP[1].key, color: 'cyan' })).data;
	assert.equal((await admin.get('/', { raw: true })).status, 200, 'several printers: the overview');
	const token = (await admin.post('/api/integrations/tokens', { name: 'homepage' })).data.token;
	assert.match(token, /^ocm_/);
	const status = await (await fetch(`${APP}/api/status`, { headers: { authorization: `Bearer ${token}` } })).json();
	assert.equal(status.printers, 2);
	assert.equal(status.items.find((i) => i.id === p2.id).name, 'Voron 2.4');
	assert.equal((await fetch(`${APP}/api/status`)).status, 401);
	assert.equal((await fetch(`${APP}/api/printers`, { headers: { authorization: `Bearer ${token}` } })).status, 401, 'tokens open nothing else');

	// --- webcams: the override on one server, OctoPrint's own settings on the other ---------
	log('webcams: proxied stream and snapshots, and cleanup when the viewer leaves');
	await fetch(`${OP[1].url}/api/settings`, {
		method: 'POST',
		headers: { 'X-Api-Key': OP[1].key, 'content-type': 'application/json' },
		body: JSON.stringify({ plugins: { classicwebcam: { stream: `${CAM}/?action=stream`, snapshot: `${CAM}/?action=snapshot`, flipH: true } } })
	});
	const cams1 = (await viewer.get(`/api/printers/${p1.id}/webcam`)).data.cameras;
	assert.deepEqual(cams1.map((c) => [c.id, c.stream, c.proxied, c.source]), [['override', 'mjpeg', true, 'override']]);
	assert.ok(!JSON.stringify(cams1).includes(String(CAM_PORT)), 'camera URLs stay server-side');
	const cams2 = (await admin.get(`/api/printers/${p2.id}/webcam`)).data.cameras;
	assert.equal(cams2[0].source, 'octoprint');
	assert.equal(cams2[0].flipH, true, 'OctoPrint’s flip setting comes along');
	const snap = await fetch(`${APP}/api/printers/${p2.id}/webcam/snapshot`, { headers: { cookie: viewer.cookie } });
	assert.equal(snap.headers.get('content-type'), 'image/jpeg');
	assert.ok((await snap.arrayBuffer()).byteLength > 1000);
	const ctrl = new AbortController();
	const stream = await fetch(`${APP}/api/printers/${p1.id}/webcam/stream`, { headers: { cookie: viewer.cookie }, signal: ctrl.signal });
	assert.match(stream.headers.get('content-type'), /multipart\/x-mixed-replace/);
	let got = Buffer.alloc(0);
	for await (const chunk of stream.body) {
		got = Buffer.concat([got, chunk]);
		// Two JPEG frames (FF D8 start-of-image markers) are enough.
		if (got.indexOf(Buffer.from([0xff, 0xd8]), got.indexOf(Buffer.from([0xff, 0xd8])) + 2) !== -1) break;
	}
	assert.equal(cam.stats.active, 1, 'one upstream stream while watching');
	ctrl.abort();
	await waitFor(() => cam.stats.active === 0, 'the camera stream to close after the viewer left', { tries: 20 });

	// --- browser: screenshots and the cancel confirmation -----------------------------------
	log('browser: screenshots and UI flows');
	// Heat and a print on the second printer, and a file to print from the UI on the first.
	await admin.post(`/api/printers/${p1.id}/temperature`, { targets: { tool0: 215, bed: 60 } });
	await admin.post(`/api/printers/${p2.id}/temperature`, { targets: { tool0: 240, bed: 85 } });
	await uploadViaApp(admin, p2.id, 'voron-cube.gcode', slowGcode(), { print: '1' });
	await uploadToOctoPrint(OP[0], 'benchy.gcode', slowGcode());
	await sleep(1500);

	browser = await chromium.launch();
	const shot = async (page, name) => {
		await page.screenshot({ path: join(SHOTS, `${name}.png`) });
		log(`  screenshot ${name}.png`);
	};
	const newPage = async (theme) => {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
		await ctx.addInitScript((t) => localStorage.setItem('ocm-theme', t), theme);
		const page = await ctx.newPage();
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
		page.errors = errors;
		return page;
	};
	const signIn = async (page, who) => {
		await page.goto(`${APP}/login`);
		await page.waitForLoadState('networkidle');
		await page.fill('#email', who.email);
		await page.fill('#pw', who.password);
		await page.click('button:has-text("Sign in")');
		await page.waitForURL((u) => !u.pathname.startsWith('/login'));
	};

	const login = await newPage('dark');
	await login.goto(`${APP}/login`);
	await login.waitForLoadState('networkidle');
	await shot(login, 'login');

	const dark = await newPage('dark');
	await signIn(dark, ADMIN);
	await dark.goto(APP);
	await dark.waitForSelector('text=Voron 2.4');
	await sleep(4000);
	await shot(dark, 'overview');

	// Files tab: upload through the file picker, delete with confirmation, print from the list.
	await dark.goto(`${APP}/p/${p1.id}?tab=files`);
	await dark.waitForSelector('tr[data-file="benchy.gcode"]');
	await dark.setInputFiles('[data-testid=file-input]', { name: 'ui-upload.gcode', mimeType: 'text/x-gcode', buffer: Buffer.from('G28\nG1 X5 Y5\n') });
	await dark.waitForSelector('tr[data-file="ui-upload.gcode"]');
	await dark.click('button[aria-label="Delete ui-upload.gcode"]');
	await dark.waitForSelector('dialog[open] >> text=Delete ui-upload.gcode?');
	await dark.click('dialog[open] button:has-text("Delete")');
	await dark.waitForSelector('tr[data-file="ui-upload.gcode"]', { state: 'detached' });
	await sleep(800);
	await shot(dark, 'files');
	await dark.click('tr[data-file="benchy.gcode"] button:has-text("Print")');
	await waitFor(async () => (await opState(OP[0])).startsWith('Printing'), 'printing from the Files tab');

	await dark.goto(`${APP}/p/${p1.id}`);
	await dark.waitForSelector('text=live push');
	await dark.waitForSelector('img[alt="Webcam live"]');
	await sleep(6000);
	await shot(dark, 'printer');
	assert.ok(cam.stats.active >= 1, 'the dashboard shows the live stream');

	await dark.goto(`${APP}/p/${p1.id}?tab=webcam`);
	await dark.waitForSelector('img[alt="Webcam live"]');
	await sleep(1500);
	await shot(dark, 'webcam');

	// Cancel through the header button: the confirmation dialog must appear first.
	await dark.click('header button:has-text("Cancel print")');
	await dark.waitForSelector('dialog[open] >> text=Cancel this print?');
	await shot(dark, 'confirm-cancel');
	await dark.click('dialog[open] button:has-text("Cancel print")');
	await waitFor(async () => (await opState(OP[0])) === 'Operational', 'cancelled from the UI');
	const uiAudit = (await admin.get('/api/audit?action=job.cancel')).data;
	assert.equal(uiAudit[0].userEmail, ADMIN.email, 'the UI cancel is audited as the admin');
	await dark.goto(`${APP}/p/${p1.id}`);
	await dark.waitForSelector('text=live push');

	// Set a temperature through the UI's preset button.
	await dark.click('button:has-text("PETG")');
	await waitFor(async () => (await admin.get('/api/printers/status')).data.find((s) => s.id === p1.id)?.temps.tool0?.target === 235, 'PETG preset applied');

	await dark.goto(`${APP}/settings`);
	await dark.waitForSelector('text=Backup');
	await waitFor(() => cam.stats.active === 0, 'browser camera streams to close after leaving the page', { tries: 20 });
	await sleep(500);
	await shot(dark, 'settings');
	await dark.goto(`${APP}/users`);
	await dark.waitForSelector('text=operator@example.com');
	await shot(dark, 'users');
	await dark.goto(`${APP}/integrations`);
	await dark.waitForSelector('text=Status API tokens');
	await shot(dark, 'integrations');
	await dark.goto(`${APP}/audit`);
	await dark.waitForSelector('text=Cancelled print');
	await shot(dark, 'audit');

	const light = await newPage('light');
	await signIn(light, ADMIN);
	await light.goto(APP);
	await light.waitForSelector('text=Voron 2.4');
	await sleep(3000);
	await shot(light, 'overview-light');
	await light.goto(`${APP}/p/${p2.id}`);
	await light.waitForSelector('text=live push');
	await sleep(6000);
	await shot(light, 'printer-light');

	// A viewer sees no control buttons.
	const view = await newPage('dark');
	await signIn(view, VIEWER);
	await view.goto(`${APP}/p/${p2.id}`);
	await view.waitForSelector('text=live push');
	assert.equal(await view.locator('button:has-text("Pause")').count(), 0, 'viewers get no job controls');
	assert.equal(await view.locator('button:has-text("Stop")').count(), 0, 'viewers get no emergency stop');
	assert.equal(await view.locator('input[aria-label="Hotend target"]').count(), 0, 'viewers get no temperature inputs');

	for (const p of [login, dark, light, view]) assert.deepEqual(p.errors, [], 'no browser errors');

	await admin.post(`/api/printers/${p2.id}/job`, { command: 'cancel', confirm: true });
	log('all e2e checks passed');
	writeFileSync(join(dataDir, 'app.log'), appLog);
}

async function cleanup() {
	await browser?.close().catch(() => {});
	await cam?.close().catch(() => {});
	if (process.env.E2E_KEEP) {
		log(`E2E_KEEP: app still running on ${APP} (pid ${app?.pid}), data in ${dataDir}`);
		return;
	}
	app?.kill();
	try {
		devOctoprint('down');
	} catch {}
	rmSync(dataDir, { recursive: true, force: true });
}

try {
	await main();
	await cleanup();
	process.exit(0);
} catch (err) {
	console.error('✗ e2e failed:', err);
	await cleanup();
	process.exit(1);
}
