// End-to-end test of the print history and timelapses against real OctoPrint servers
// (virtual printers in Docker), with and without a browser watching.
//
//   pnpm e2e:history                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:history        # leave the containers and app running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:history  # reuse ./build
//
// Ports (override with the env vars): app 3161, OctoPrint 5141–5142, test camera 5241.
// Needs Docker and a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMjpegSource } from '../mjpeg-source.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3161);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_BASE = Number(process.env.E2E_OP_PORT_BASE ?? 5141);
const OP_PREFIX = process.env.E2E_OP_PREFIX ?? 'octo-modern-hist-e2e-op';
const CAM_PORT = Number(process.env.E2E_CAM_PORT ?? 5241);
const CAM = `http://127.0.0.1:${CAM_PORT}`;
const HOOK_PORT = Number(process.env.E2E_HOOK_PORT ?? 5243);
// OctoPrint (in Docker) reaches the camera on the host this way (Docker Desktop; on Linux, --add-host).
const CAM_FROM_DOCKER = `http://host.docker.internal:${CAM_PORT}`;
const OP = [1, 2].map((i) => ({ url: `http://127.0.0.1:${OP_BASE + i - 1}`, key: `ocm-dev-key-${i}` }));
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const opEnv = { ...process.env, OCM_OP_PORT_BASE: String(OP_BASE), OCM_OP_PREFIX: OP_PREFIX };
const devOctoprint = (...args) => execFileSync(join(ROOT, 'scripts/dev-octoprint.sh'), args, { env: opEnv, stdio: 'inherit' });

let app;
let browser;
let cam;
let hookServer;
/** Webhook notifications received: { headers, body }. */
const hooks = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-history-'));

async function waitFor(fn, label, { tries = 120, every = 500 } = {}) {
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
	const call = async (method, path, body, { raw = false, headers = {} } = {}) => {
		const res = await fetch(`${APP}${path}`, {
			method,
			redirect: 'manual',
			headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), origin: APP, ...headers },
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
		patch: (p, b) => call('PATCH', p, b),
		del: (p) => call('DELETE', p, {}),
		get cookie() {
			return cookie;
		}
	};
}

/** G-code the virtual printer takes about `seconds` to print: short extruding moves with 1 s dwells. */
function timedGcode(seconds) {
	const lines = ['; octo-modern history e2e', 'G21', 'G90', 'M82', 'G28', 'G92 E0', 'G1 Z0.2 F600'];
	for (let i = 0; i < seconds; i++) {
		lines.push(`G1 X${20 + (i % 10) * 8} Y${20 + Math.floor(i / 10) * 8} E${(i + 1) * 40} F1800`);
		if (i % 3 === 0) lines.push(`G1 Z${(0.2 + i * 0.2).toFixed(2)} F600`);
		lines.push('G4 P1000');
	}
	lines.push('M84');
	return lines.join('\n') + '\n';
}

async function op(o, method, path, body) {
	const res = await fetch(`${o.url}${path}`, {
		method,
		headers: { 'X-Api-Key': o.key, ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined
	});
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function uploadToOctoPrint(o, name, content, { print = false } = {}) {
	const fd = new FormData();
	fd.set('file', new Blob([content]), name);
	if (print) {
		fd.set('select', 'true');
		fd.set('print', 'true');
	}
	const res = await fetch(`${o.url}/api/files/local`, { method: 'POST', headers: { 'X-Api-Key': o.key }, body: fd });
	assert.equal(res.status, 201, `upload to OctoPrint: ${await res.text()}`);
}

const opState = async (o) => (await op(o, 'GET', '/api/job')).state;
const lastPrint = async (o, path) => (await op(o, 'GET', `/api/files/local/${encodeURIComponent(path)}`)).prints?.last ?? null;
/** Waits for the file's analysis (filament) so the entry can report what it used. */
const analysed = (o, path) =>
	waitFor(async () => (await op(o, 'GET', `/api/files/local/${encodeURIComponent(path)}`)).gcodeAnalysis?.filament?.tool0?.length, `analysis of ${path}`);

/** History entries of one file on one printer, as `c` sees them. */
async function entries(c, printerId, file) {
	const r = await c.get(`/api/history?printer=${printerId}&q=${encodeURIComponent(file)}&limit=50`);
	assert.equal(r.status, 200, JSON.stringify(r.data));
	return r.data.items.filter((i) => i.file === file);
}

const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b} (±${tol})`);

/**
 * Prints `file` to completion or cancels it after `cancelAfter` seconds, through octo·modern
 * as `c` (or directly on OctoPrint with `direct`), and checks the history entry that results.
 */
async function printAndCheck({ c, admin, o, printerId, file, seconds, cancelAfter = null, direct = false, startedBy }) {
	const gcode = timedGcode(seconds);
	if (direct) {
		// As if started from OctoPrint's own UI or a slicer: octo·modern isn't involved.
		await uploadToOctoPrint(o, file, gcode);
		await analysed(o, file);
		assert.equal((await op(o, 'POST', `/api/files/local/${file}`, { command: 'select', print: true })) ?? '', '');
	} else {
		await uploadToOctoPrint(o, file, gcode);
		await analysed(o, file);
		assert.equal((await c.post(`/api/printers/${printerId}/files/select`, { origin: 'local', path: file, print: true })).status, 200);
	}
	await waitFor(async () => (await opState(o)).startsWith('Printing'), `${file} printing`, { every: 100 });
	const t0 = Date.now();
	// The entry opens while it prints (from the background poll when nobody watches).
	const running = await waitFor(async () => (await entries(admin, printerId, file)).find((e) => e.result === 'printing'), `${file}: a running entry`, { tries: 60 });
	assert.equal(running.endedAt, null);
	let wall = null;
	if (cancelAfter != null) {
		await sleep(Math.max(0, cancelAfter * 1000 - (Date.now() - t0)));
		wall = (Date.now() - t0) / 1000;
		if (direct) await op(o, 'POST', '/api/job', { command: 'cancel' });
		else assert.equal((await c.post(`/api/printers/${printerId}/job`, { command: 'cancel', confirm: true })).status, 200);
	}
	await waitFor(async () => (await opState(o)) === 'Operational', `${file} ended`, { tries: 240 });
	const done = await waitFor(async () => (await entries(admin, printerId, file)).find((e) => e.endedAt && e.hasThumbnail !== undefined && e.result !== 'printing'), `${file}: the finished entry`, { tries: 60 });
	// Give the picture a moment (it's taken right after the end).
	const entry = await waitFor(async () => {
		const [e] = await entries(admin, printerId, file);
		return e.hasThumbnail || Date.now() - t0 > (seconds + 30) * 1000 ? e : null;
	}, `${file}: its picture`);
	assert.equal((await entries(admin, printerId, file)).length, 1, `${file}: exactly one entry`);
	const last = await lastPrint(o, file);
	if (cancelAfter == null) {
		assert.equal(entry.result, 'success', `${file} succeeded`);
		assert.equal(entry.completion, 100);
		near(entry.durationS, last.printTime, 1.5, `${file} duration matches OctoPrint’s print time`);
		near(entry.durationS, seconds, 6, `${file} duration ≈ the G-code’s dwell time`);
		assert.ok(entry.filamentMm > 0, `${file}: filament used`);
	} else {
		assert.equal(entry.result, 'cancelled', `${file} cancelled`);
		assert.equal(last.success, false);
		near(entry.durationS, wall, 3, `${file} duration ≈ time until the cancel`);
		assert.ok(entry.completion > 0 && entry.completion < 100, `${file}: partial (${entry.completion}%)`);
	}
	assert.equal(entry.startedBy, startedBy, `${file}: started by`);
	assert.equal(entry.octoprintUser, 'admin');
	assert.equal(entry.source, 'live');
	assert.ok(done.endedAt >= entry.startedAt);
	return entry;
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting two OctoPrint servers with virtual printers');
	devOctoprint('up', '2');
	cam = await startMjpegSource({ port: CAM_PORT, host: '127.0.0.1' });
	log(`MJPEG test camera on ${CAM}`);

	// The first server records timelapses from the test camera (one frame a second).
	await op(OP[0], 'POST', '/api/settings', {
		plugins: { classicwebcam: { snapshot: `${CAM_FROM_DOCKER}/?action=snapshot`, stream: `${CAM_FROM_DOCKER}/?action=stream` } },
		webcam: { ffmpegPath: '/usr/bin/ffmpeg' }
	});
	await op(OP[0], 'POST', '/api/timelapse', { type: 'timed', interval: 1, fps: 10, postRoll: 0, save: true });

	if (!process.env.E2E_SKIP_BUILD) {
		log('building');
		execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'ignore' });
	}
	log(`starting octo·modern on ${APP}`);
	app = spawn('node', ['build'], {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			PORT: String(APP_PORT),
			HOST: '127.0.0.1',
			OCM_DATA_DIR: dataDir,
			OCM_POLL_INTERVAL_MS: '3000',
			OCM_ADMIN_EMAIL: ADMIN.email,
			OCM_ADMIN_PASSWORD: ADMIN.password,
			OCM_ADMIN_NAME: ADMIN.name,
			NODE_OPTIONS: '--disable-warning=ExperimentalWarning'
		}
	});
	let appLog = '';
	app.stdout.on('data', (d) => (appLog += d));
	app.stderr.on('data', (d) => (appLog += d));
	process.on('exit', () => {
		try {
			writeFileSync(join(dataDir, 'app.log'), appLog);
		} catch {}
	});
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');

	const admin = client();
	assert.equal((await admin.post('/api/auth/login', ADMIN)).status, 200);
	const mk4 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: OP[0].url, apiKey: OP[0].key, color: 'violet', webcamUrl: `${CAM}/?action=stream` })).data;
	const voron = (await admin.post('/api/printers', { name: 'Voron 2.4', baseUrl: OP[1].url, apiKey: OP[1].key, color: 'cyan', webcamUrl: `${CAM}/?action=stream` })).data;
	for (const u of [
		{ ...OPERATOR, role: 'operator' },
		{ ...VIEWER, role: 'viewer' }
	]) assert.equal((await admin.post('/api/users', u)).status, 201);
	const operator = client();
	const viewer = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);
	await waitFor(async () => (await admin.get('/api/printers/status')).data.every((s) => s.state === 'operational'), 'both printers ready');

	// A webhook that hears about every print's end.
	hookServer = createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			hooks.push({ headers: req.headers, body: JSON.parse(body) });
			res.end('ok');
		});
	});
	await new Promise((r) => hookServer.listen(HOOK_PORT, '127.0.0.1', r));
	assert.equal((await operator.get('/api/settings/notifications')).status, 403, 'notification settings are for admins');
	// A version-1 webhook (the payload from before the notifications rework) for print ends.
	const saved = await admin.post('/api/settings/notifications/channels', {
		type: 'webhook',
		name: 'e2e hook',
		config: { format: '1' },
		secrets: { url: `http://127.0.0.1:${HOOK_PORT}/print`, authorization: 'Bearer e2e' }
	});
	assert.equal(saved.status, 201, JSON.stringify(saved.data));
	const rules = await admin.put('/api/settings/notifications', {
		publicUrl: APP,
		rules: [{ name: 'Print ends', printers: 'all', events: ['print.finished', 'print.failed', 'print.cancelled'], channels: [saved.data.channel.id] }]
	});
	assert.equal(rules.status, 200, JSON.stringify(rules.data));
	assert.equal((await admin.post('/api/settings/notifications/test', { id: saved.data.channel.id })).status, 200);
	assert.equal(hooks.shift().body.event, 'test');

	// --- nobody watching: the background poll notices, the push socket is held while printing ----
	log('no browser: a print started on OctoPrint itself, to completion');
	const e1 = await printAndCheck({ c: admin, admin, o: OP[0], printerId: mk4.id, file: 'unwatched-done.gcode', seconds: 14, direct: true, startedBy: null });
	assert.ok(e1.hasThumbnail, 'a webcam picture of the finished print');
	const pic = await fetch(`${APP}/api/history/${e1.id}/thumbnail`, { headers: { cookie: viewer.cookie } });
	assert.equal(pic.status, 200);
	assert.equal(pic.headers.get('content-type'), 'image/jpeg');
	const picBytes = (await pic.arrayBuffer()).byteLength;
	assert.ok(picBytes > 1000 && picBytes <= 100 * 1024, `picture is ${picBytes} bytes`);

	log('no browser: a print started through octo·modern by the operator, cancelled');
	await printAndCheck({ c: operator, admin, o: OP[0], printerId: mk4.id, file: 'unwatched-cancel.gcode', seconds: 40, cancelAfter: 9, startedBy: OPERATOR.name });

	// --- a browser watching the printer (push socket open the whole time) ----------------------
	browser = await chromium.launch();
	const newPage = async (theme) => {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme, acceptDownloads: true });
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
	const dark = await newPage('dark');
	await signIn(dark, ADMIN);
	await dark.goto(`${APP}/p/${voron.id}?tab=jobs`);
	await dark.waitForSelector('select[aria-label="Result"]');
	await sleep(1500);
	log('browser watching: a print to completion, then one cancelled from the header button');
	const e3 = await printAndCheck({ c: admin, admin, o: OP[1], printerId: voron.id, file: 'watched-done.gcode', seconds: 12, startedBy: ADMIN.name });
	// The open History tab picks it up from the live events.
	await dark.waitForSelector('tr[data-print="watched-done.gcode"][data-result="success"]', { timeout: 20_000 });
	await uploadToOctoPrint(OP[1], 'watched-cancel.gcode', timedGcode(40));
	await analysed(OP[1], 'watched-cancel.gcode');
	assert.equal((await admin.post(`/api/printers/${voron.id}/files/select`, { origin: 'local', path: 'watched-cancel.gcode', print: true })).status, 200);
	await waitFor(async () => (await opState(OP[1])).startsWith('Printing'), 'watched-cancel printing', { every: 100 });
	const t0 = Date.now();
	await dark.waitForSelector('tr[data-print="watched-cancel.gcode"][data-result="printing"]', { timeout: 20_000 });
	await sleep(8000);
	await dark.click('header button:has-text("Cancel print")');
	await dark.click('dialog[open] button:has-text("Cancel print")');
	const wall = (Date.now() - t0) / 1000;
	await waitFor(async () => (await opState(OP[1])) === 'Operational', 'cancelled from the UI');
	const e4 = await waitFor(async () => (await entries(admin, voron.id, 'watched-cancel.gcode')).find((e) => e.endedAt && e.hasThumbnail), 'the cancelled entry');
	assert.equal(e4.result, 'cancelled');
	near(e4.durationS, wall, 3, 'watched cancel duration');
	assert.equal(e4.startedBy, ADMIN.name);
	assert.equal((await entries(admin, voron.id, 'watched-cancel.gcode')).length, 1);
	await dark.waitForSelector('tr[data-print="watched-cancel.gcode"][data-result="cancelled"]', { timeout: 20_000 });

	log('notifications: one webhook call per finished print');
	await waitFor(() => hooks.length >= 4, 'four webhook notifications', { tries: 20 });
	assert.deepEqual(hooks.map((h) => `${h.body.print.file}:${h.body.event}`).sort(), ['unwatched-cancel.gcode:cancelled', 'unwatched-done.gcode:success', 'watched-cancel.gcode:cancelled', 'watched-done.gcode:success']);
	assert.equal(hooks[0].headers.authorization, 'Bearer e2e');
	assert.equal(hooks[0].body.source, 'octo-modern');
	assert.match(hooks[0].body.url, new RegExp(`^${APP}/p/`), 'links back to the printer');

	// --- history API: access, stats, CSV, notes, import, delete ------------------------------
	log('history API: who sees and changes what, stats, CSV, import');
	const all = (await viewer.get('/api/history')).data;
	assert.equal(all.total, 4, 'four prints recorded, visible to viewers');
	const stats = (await viewer.get('/api/history/stats')).data;
	assert.equal(stats.prints, 4);
	assert.equal(stats.success, 2);
	assert.equal(stats.cancelled, 2);
	assert.equal(stats.successRate, 0.5);
	assert.deepEqual(stats.perPrinter.map((p) => p.prints).sort(), [2, 2]);
	assert.ok(stats.filamentMm > 0 && stats.printTime > 20);
	assert.equal((await viewer.get(`/api/history/stats?printer=${mk4.id}&result=success`)).data.prints, 1);
	const csv = await viewer.get('/api/history/export.csv', { raw: true });
	assert.match(csv.headers.get('content-type'), /text\/csv/);
	assert.match(csv.headers.get('content-disposition'), /attachment; filename="print-history-/);
	const csvLines = (await csv.text()).trim().split('\r\n');
	assert.equal(csvLines.length, 5, 'header and four rows');
	assert.match(csvLines[0], /^id,printer,file,path,origin,started_at/);
	assert.ok(csvLines.some((l) => l.includes('watched-cancel.gcode') && l.includes(',cancelled,')));
	assert.equal((await viewer.patch(`/api/history/${e1.id}`, { notes: 'nope' })).status, 403, 'viewers can’t write notes');
	assert.equal((await operator.patch(`/api/history/${e1.id}`, { notes: 'Galaxy black PLA, 0.2 mm' })).data.notes, 'Galaxy black PLA, 0.2 mm');
	assert.equal((await operator.del(`/api/history/${e1.id}`)).status, 403, 'operators can’t delete entries');
	assert.equal((await operator.post('/api/history/import', {})).status, 403, 'operators can’t import');
	const imp = (await admin.post('/api/history/import', {})).data;
	assert.equal(imp.imported, 0, 'OctoPrint’s stats describe prints already recorded live');
	assert.equal((await viewer.get('/api/history')).data.total, 4, 'no duplicates after importing');

	// --- timelapses -------------------------------------------------------------------------------
	log('timelapses: listing, Range requests, download, delete, settings');
	const tl = await waitFor(async () => {
		const l = (await viewer.get(`/api/printers/${mk4.id}/timelapse`)).data;
		return l.files.length >= 2 && !l.unrendered.some((u) => u.rendering || u.processing) ? l : null;
	}, 'two rendered timelapses');
	assert.equal(tl.config.type, 'timed');
	const video = tl.files.find((f) => f.name.startsWith('unwatched-done') && f.playable);
	assert.ok(video, `the finished print’s video (${tl.files.map((f) => f.name)})`);
	assert.ok(tl.files.some((f) => /^unwatched-cancel.*-fail\.mp4$/.test(f.name)), 'the cancelled print’s video');
	assert.ok(video.thumbnail);
	const vUrl = `/api/printers/${mk4.id}/timelapse/file?name=${encodeURIComponent(video.name)}`;
	const full = await viewer.get(vUrl, { raw: true });
	assert.equal(full.status, 200);
	assert.equal(full.headers.get('content-type'), 'video/mp4');
	assert.equal(full.headers.get('accept-ranges'), 'bytes');
	assert.match(full.headers.get('content-disposition'), /^inline;/);
	const fullBytes = Buffer.from(await full.arrayBuffer());
	assert.equal(fullBytes.length, video.bytes);
	assert.equal(fullBytes.subarray(4, 8).toString(), 'ftyp', 'an MP4');
	const part = await viewer.get(vUrl, { raw: true, headers: { range: 'bytes=100-199' } });
	assert.equal(part.status, 206, 'Range requests reach OctoPrint and come back partial');
	assert.equal(part.headers.get('content-range'), `bytes 100-199/${video.bytes}`);
	assert.equal(part.headers.get('content-length'), '100');
	assert.deepEqual(Buffer.from(await part.arrayBuffer()), fullBytes.subarray(100, 200));
	const tail = await viewer.get(vUrl, { raw: true, headers: { range: `bytes=${video.bytes - 10}-` } });
	assert.equal(tail.status, 206);
	assert.equal((await tail.arrayBuffer()).byteLength, 10);
	const etag = full.headers.get('etag');
	if (etag) assert.equal((await viewer.get(vUrl, { raw: true, headers: { 'if-none-match': etag } })).status, 304, 'conditional requests pass through');
	const dl = await viewer.get(`${vUrl}&download=1`, { raw: true });
	assert.match(dl.headers.get('content-disposition'), /^attachment; filename="unwatched-done/);
	await dl.body?.cancel();
	const thumb = await viewer.get(`/api/printers/${mk4.id}/timelapse/file?name=${encodeURIComponent(video.thumbnail)}`, { raw: true });
	assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
	assert.equal((await viewer.get(`/api/printers/${mk4.id}/timelapse/file?name=..%2Fsecret`)).status, 400);
	assert.equal((await viewer.get(`/api/printers/${mk4.id}/timelapse/file?name=nope.mp4`)).status, 404);

	const failVideo = tl.files.find((f) => f.name.includes('-fail'));
	assert.equal((await viewer.del(`/api/printers/${mk4.id}/timelapse/file?name=${encodeURIComponent(failVideo.name)}&confirm=1`)).status, 403, 'viewers can’t delete');
	assert.equal((await operator.del(`/api/printers/${mk4.id}/timelapse/file?name=${encodeURIComponent(failVideo.name)}`)).status, 409, 'deleting needs confirming');
	assert.equal((await operator.del(`/api/printers/${mk4.id}/timelapse/file?name=${encodeURIComponent(failVideo.name)}&confirm=1`)).status, 200);
	assert.ok(!(await op(OP[0], 'GET', '/api/timelapse')).files.some((f) => f.name === failVideo.name), 'gone from OctoPrint');

	assert.equal((await operator.post(`/api/printers/${mk4.id}/timelapse`, { type: 'off' })).status, 403, 'only admins change the settings');
	assert.equal((await admin.post(`/api/printers/${mk4.id}/timelapse`, { type: 'timed', fps: 0 })).status, 400);
	const changed = (await admin.post(`/api/printers/${mk4.id}/timelapse`, { type: 'zchange', fps: 25, postRoll: 2, minDelay: 3 })).data;
	assert.equal(changed.config.type, 'zchange');
	assert.equal((await op(OP[0], 'GET', '/api/timelapse')).config.fps, 25, 'saved on OctoPrint');
	await admin.post(`/api/printers/${mk4.id}/timelapse`, { type: 'timed', interval: 1, fps: 10, postRoll: 0 });

	// --- browser: timelapse tab, history page, screenshots -----------------------------------------
	log('browser: timelapse player, history pages, screenshots');
	const shot = async (page, name) => {
		await page.screenshot({ path: join(SHOTS, `${name}.png`) });
		log(`  screenshot ${name}.png`);
	};
	await dark.goto(`${APP}/p/${mk4.id}?tab=camera&view=timelapse`);
	await dark.waitForSelector(`[data-timelapse="${video.name}"] img`);
	await sleep(800);
	await shot(dark, 'timelapse');
	await dark.click(`[data-timelapse="${video.name}"] button[aria-label^="Play"]`);
	await dark.waitForFunction(() => {
		const v = document.querySelector('[data-testid=timelapse-player]');
		return v && v.readyState >= 2 && v.duration > 0;
	});
	// Seeking works because Range requests do: jump near the end and get a frame there.
	await dark.evaluate(() => {
		const v = document.querySelector('[data-testid=timelapse-player]');
		v.pause();
		v.currentTime = Math.max(0, v.duration - 0.3);
	});
	await dark.waitForFunction(() => {
		const v = document.querySelector('[data-testid=timelapse-player]');
		return v.currentTime > 0 && !v.seeking && v.readyState >= 2;
	});
	await sleep(400);
	await shot(dark, 'timelapse-player');
	const lightTl = await newPage('light');
	await signIn(lightTl, ADMIN);
	// The old Timelapse tab's link lands on Camera › Timelapses.
	await lightTl.goto(`${APP}/p/${mk4.id}?tab=timelapse`);
	await lightTl.waitForURL(/tab=camera&view=timelapse/);
	await lightTl.waitForSelector(`[data-timelapse="${video.name}"] img`);
	await sleep(800);
	await shot(lightTl, 'timelapse-light');
	await lightTl.close();
	// Delete from the UI, with the confirmation.
	await dark.click(`button[aria-label="Delete ${video.name}"]`);
	await dark.waitForSelector('dialog[open] >> text=Delete this timelapse?');
	await dark.click('dialog[open] button:has-text("Delete")');
	await dark.waitForSelector(`[data-timelapse="${video.name}"]`, { state: 'detached' });
	assert.ok(!(await op(OP[0], 'GET', '/api/timelapse')).files.some((f) => f.name === video.name));

	await dark.goto(`${APP}/history`);
	await dark.waitForSelector('tr[data-print="unwatched-done.gcode"]');
	await sleep(800);
	await shot(dark, 'history');
	await dark.click('tr[data-print="unwatched-done.gcode"]');
	await dark.waitForSelector('dialog[open] #print-notes');
	assert.equal(await dark.inputValue('dialog[open] #print-notes'), 'Galaxy black PLA, 0.2 mm');
	await sleep(500);
	await shot(dark, 'history-entry');
	await dark.keyboard.press('Escape');
	// Filters: result and search.
	await dark.selectOption('select[aria-label="Result"]', 'cancelled');
	await dark.waitForSelector('tr[data-print="unwatched-done.gcode"]', { state: 'detached' });
	assert.equal(await dark.locator('tbody tr[data-print]').count(), 2);
	await dark.selectOption('select[aria-label="Result"]', '');
	await dark.fill('input[aria-label="Search history"]', 'galaxy');
	await dark.waitForFunction(() => document.querySelectorAll('tbody tr[data-print]').length === 1);
	const [download] = await Promise.all([dark.waitForEvent('download'), dark.click('a:has-text("Export CSV")')]);
	assert.match(download.suggestedFilename(), /^print-history-.*\.csv$/);
	await dark.fill('input[aria-label="Search history"]', '');

	// Reprint from the history (operator), then cancel it.
	const opPage = await newPage('dark');
	await signIn(opPage, OPERATOR);
	await opPage.goto(`${APP}/history`);
	await opPage.waitForSelector('tr[data-print="watched-done.gcode"]');
	assert.equal(await opPage.locator('button[aria-label^="Delete entry"]').count(), 0, 'operators get no delete buttons');
	await opPage.click('tr[data-print="watched-done.gcode"] button[aria-label^="Print"]');
	await opPage.click('dialog[open] button:has-text("Print")');
	await waitFor(async () => (await opState(OP[1])).startsWith('Printing'), 'reprinting');
	assert.equal((await op(OP[1], 'GET', '/api/job')).job.file.name, 'watched-done.gcode');
	await waitFor(async () => (await opState(OP[1])) === 'Operational', 'the reprint finished', { tries: 120 });
	await waitFor(async () => (await entries(admin, voron.id, 'watched-done.gcode')).filter((e) => e.result === 'success').length === 2, 'the reprint recorded');
	assert.equal((await entries(admin, voron.id, 'watched-done.gcode'))[0].startedBy, OPERATOR.name);

	// octo·modern follows the printer back to ready (the push socket held for the print is released).
	await waitFor(async () => (await admin.get('/api/printers/status')).data.find((s) => s.id === voron.id)?.state === 'operational', 'the Voron ready again in octo·modern', { tries: 40 });

	// Admin deletes an entry from the UI.
	await dark.goto(`${APP}/p/${voron.id}?tab=jobs`);
	await dark.waitForSelector('tr[data-print="watched-cancel.gcode"]');
	await sleep(600);
	await shot(dark, 'printer-history');
	await dark.click('button[aria-label="Delete entry watched-cancel.gcode"]');
	await dark.click('dialog[open] button:has-text("Delete")');
	await dark.waitForSelector('tr[data-print="watched-cancel.gcode"]', { state: 'detached' });
	assert.equal((await entries(admin, voron.id, 'watched-cancel.gcode')).length, 0);
	assert.ok((await admin.get('/api/audit?action=history.delete')).data.length === 1, 'deletions are audited');

	const light = await newPage('light');
	await signIn(light, ADMIN);
	await light.goto(`${APP}/history`);
	await light.waitForSelector('tr[data-print="unwatched-done.gcode"]');
	await sleep(800);
	await shot(light, 'history-light');

	for (const p of [dark, light, opPage]) assert.deepEqual(p.errors, [], 'no browser errors');
	log('all history e2e checks passed');
}

async function cleanup(ok) {
	await browser?.close().catch(() => {});
	await cam?.close().catch(() => {});
	hookServer?.closeAllConnections?.();
	hookServer?.close();
	if (process.env.E2E_KEEP) {
		log(`E2E_KEEP: app still running on ${APP} (pid ${app?.pid}), data in ${dataDir}`);
		return;
	}
	app?.kill();
	try {
		devOctoprint('down');
	} catch {}
	if (ok) rmSync(dataDir, { recursive: true, force: true });
}

try {
	await main();
	await cleanup(true);
	process.exit(0);
} catch (err) {
	console.error('✗ e2e failed:', err);
	console.error(`  app log: ${join(dataDir, 'app.log')}`);
	await cleanup(false);
	process.exit(1);
}
