// End-to-end test of failure detection against a mock OctoPrint, a mock webcam and a
// mock of Obico's ML API (no Docker, no real Obico image, no network beyond 127.0.0.1).
//
//   pnpm e2e:detect                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:detect        # leave the app running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:detect  # reuse ./build
//
// The mock ML API behaves like obico-server's ml_api/server.py: GET /p/?img=<url> with
// `Authorization: Bearer <ML_API_TOKEN>`, downloads the image from that URL (from
// octo·modern's one-time frame link) and answers {"detections": [[label, conf, [xc, yc, w, h]], …]},
// here from a canned script: a few clean frames, then spaghetti.
//
// Ports (override with the env vars): app 3240, OctoPrint 3244, ML API 3245, webhook 3246.
// Needs a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3240);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_PORT = Number(process.env.E2E_OP_PORT ?? 3244);
const OP = `http://127.0.0.1:${OP_PORT}`;
const ML_PORT = Number(process.env.E2E_ML_PORT ?? 3245);
const ML = `http://127.0.0.1:${ML_PORT}`;
const HOOK_PORT = Number(process.env.E2E_HOOK_PORT ?? 3246);
const ML_TOKEN = 'e2e-ml-api-token';
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

let app;
let debugState = async () => null;
let browser;
const servers = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-detect-'));

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
	return { get: (p, o) => call('GET', p, undefined, o), post: (p, b, o) => call('POST', p, b ?? {}, o), put: (p, b) => call('PUT', p, b) };
}

const listen = (s, port) => new Promise((r) => s.listen(port, '127.0.0.1', () => (servers.push(s), r())));
const readBody = (req) => new Promise((r) => {
	let b = '';
	req.on('data', (d) => (b += d));
	req.on('end', () => r(b));
});

// --- demo webcam frames, rendered once ------------------------------------------------------

/** Two 640×360 JPEGs of a printer: a clean print, and the same print gone to spaghetti. */
async function renderFrames() {
	const b = await chromium.launch();
	const page = await b.newPage({ viewport: { width: 640, height: 360 } });
	await page.setContent(`<style>html,body{margin:0;background:#000}</style><canvas id="c" width="640" height="360"></canvas>`);
	const shot = async (spaghetti) => {
		await page.evaluate((spaghetti) => {
			const g = document.getElementById('c').getContext('2d');
			let seed = 7;
			const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
			const bg = g.createLinearGradient(0, 0, 0, 360);
			bg.addColorStop(0, '#24212c');
			bg.addColorStop(1, '#0e0c13');
			g.fillStyle = bg;
			g.fillRect(0, 0, 640, 360);
			// frame and gantry
			g.fillStyle = '#3a3646';
			g.fillRect(40, 40, 14, 260);
			g.fillRect(586, 40, 14, 260);
			g.fillRect(40, 70, 560, 12);
			// bed
			const bed = g.createLinearGradient(0, 290, 0, 310);
			bed.addColorStop(0, '#4a4558');
			bed.addColorStop(1, '#2a2733');
			g.fillStyle = bed;
			g.fillRect(90, 292, 460, 16);
			// the part: a box, layer by layer
			for (let l = 0; l < 18; l++) {
				g.fillStyle = `hsl(272, 62%, ${34 + (l % 2) * 4 + l}%)`;
				g.fillRect(200, 286 - l * 6, 150, 5);
			}
			if (spaghetti) {
				// filament spilling off the side: loose loops and strands
				g.lineCap = 'round';
				for (let i = 0; i < 70; i++) {
					g.strokeStyle = `hsla(272, 70%, ${45 + rnd() * 25}%, 0.9)`;
					g.lineWidth = 1.5 + rnd() * 1.5;
					g.beginPath();
					let x = 340 + rnd() * 60;
					let y = 180 + rnd() * 40;
					g.moveTo(x, y);
					for (let k = 0; k < 4; k++) {
						const nx = 330 + rnd() * 190;
						const ny = 170 + rnd() * 120;
						g.bezierCurveTo(x + (rnd() - 0.5) * 120, y + (rnd() - 0.2) * 90, nx + (rnd() - 0.5) * 120, ny - rnd() * 60, nx, ny);
						x = nx;
						y = ny;
					}
					g.stroke();
				}
			}
			// nozzle, high above the part when it's spaghetti
			const nz = spaghetti ? 150 : 172;
			g.fillStyle = '#8a8496';
			g.fillRect(spaghetti ? 410 : 300, 82, 34, nz - 82);
			g.fillStyle = '#c9a227';
			g.beginPath();
			g.moveTo(spaghetti ? 418 : 308, nz);
			g.lineTo(spaghetti ? 436 : 326, nz);
			g.lineTo(spaghetti ? 427 : 317, nz + 10);
			g.fill();
			g.fillStyle = 'rgba(255,255,255,0.55)';
			g.font = '12px monospace';
			g.fillText('CAM 1  ' + (spaghetti ? '02:41:09' : '02:38:52'), 14, 22);
		}, spaghetti);
		return await page.locator('#c').screenshot({ type: 'jpeg', quality: 85 });
	};
	const clean = await shot(false);
	const failed = await shot(true);
	await b.close();
	return { clean, failed };
}

// --- mocks -----------------------------------------------------------------------------------

/** OctoPrint: just what octo·modern polls (REST; no push socket, so it falls back to polling), job pause/resume, and a snapshot URL. */
function mockOctoPrint(frames) {
	const s = { state: 'Printing', startedAt: Date.now() - 42 * 60_000, pauses: 0, spaghetti: false };
	const server = createServer(async (req, res) => {
		const send = (o, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
		const url = new URL(req.url, 'http://x');
		const keyOk = req.headers['x-api-key'] === 'e2e-octoprint-key';
		if (url.pathname === '/webcam/' && url.searchParams.get('action') === 'snapshot') {
			return res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }).end(s.spaghetti ? frames.failed : frames.clean);
		}
		if (!keyOk) return send({ error: 'Forbidden' }, 403);
		const active = s.state !== 'Operational';
		if (url.pathname === '/api/version') return send({ api: '0.1', server: '1.11.2', text: 'OctoPrint 1.11.2' });
		if (url.pathname === '/api/printer') {
			return send({
				state: { text: s.state, flags: { operational: true, printing: s.state === 'Printing', paused: s.state === 'Paused', pausing: false, resuming: false, cancelling: false, finishing: false, ready: !active, error: false, closedOrError: false } },
				temperature: { tool0: { actual: 214.6, target: 215 }, bed: { actual: 59.8, target: 60 } }
			});
		}
		if (url.pathname === '/api/job' && req.method === 'GET') {
			const printTime = active ? Math.round((Date.now() - s.startedAt) / 1000) : null;
			return send({
				job: { file: active ? { name: 'cable-chain-x12.gcode', display: 'cable-chain-x12.gcode', path: 'cable-chain-x12.gcode', origin: 'local', size: 1843200 } : { name: null }, estimatedPrintTime: 4 * 3600, filament: { tool0: { length: 9120, volume: 21.9 } }, user: 'ada' },
				progress: { completion: active ? Math.min(99, (printTime / (4 * 3600)) * 100) : null, printTime, printTimeLeft: active ? 4 * 3600 - printTime : null, printTimeLeftOrigin: 'estimate', filepos: 1 },
				state: s.state
			});
		}
		if (url.pathname === '/api/job' && req.method === 'POST') {
			const b = JSON.parse((await readBody(req)) || '{}');
			if (b.command === 'pause' && b.action === 'pause' && s.state === 'Printing') {
				s.pauses++;
				s.state = 'Paused';
			} else if (b.command === 'pause' && b.action === 'resume' && s.state === 'Paused') s.state = 'Printing';
			return res.writeHead(204).end();
		}
		if (url.pathname === '/api/settings') return send({ webcam: { webcamEnabled: true, streamUrl: null, snapshotUrl: '/webcam/?action=snapshot' }, feature: {}, temperature: { profiles: [] } });
		if (url.pathname.startsWith('/api/files')) return send({ files: [], free: 1e10, total: 2e10 });
		if (url.pathname === '/api/printerprofiles') return send({ profiles: {} });
		if (url.pathname === '/api/connection') return send({ current: { state: s.state, port: 'VIRTUAL', baudrate: 115200, printerProfile: '_default' }, options: { ports: ['VIRTUAL'], baudrates: [115200], printerProfiles: [] } });
		send({ error: 'Not found' }, 404);
	});
	return { s, server };
}

/**
 * Obico's ml_api, as far as octo·modern can tell: GET /p/?img=<url> with the bearer token,
 * downloads the image from that URL, answers detections. `script` decides how many boxes.
 */
function mockMlApi(ocp) {
	const calls = [];
	const m = { calls, failAfter: Infinity };
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://x');
		const json = (o, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
		if (url.pathname === '/hc/') return res.end('ok');
		if (url.pathname !== '/p/') return res.writeHead(404).end();
		if (req.headers.authorization !== `Bearer ${ML_TOKEN}`) return res.writeHead(401).end();
		const img = url.searchParams.get('img');
		if (!img) return json({ detections: [], message: `Invalid request params: ${url.search}` }, 422);
		let first;
		let second;
		try {
			first = await fetch(img);
			const bytes = new Uint8Array(await first.arrayBuffer());
			second = await fetch(img); // the link must not work twice
			await second.arrayBuffer();
			const call = { img, status: first.status, type: first.headers.get('content-type'), bytes: bytes.length, again: second.status, jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 };
			calls.push(call);
			if (first.status !== 200) return json({ detections: [], message: `Failed to get image ${img} - ${first.status}` }, 400);
		} catch (err) {
			return json({ detections: [], message: `Failed to get image - ${err.message}` }, 400);
		}
		const n = calls.length;
		if (n > m.failAfter) ocp.s.spaghetti = true;
		const spaghetti = ocp.s.spaghetti;
		// Boxes are [centre x, centre y, width, height] in pixels of the 640×360 frame.
		const detections = spaghetti
			? [
					['failure', 0.91, [452, 232, 150, 104]],
					['failure', 0.78, [372, 214, 74, 70]],
					['failure', 0.64, [500, 278, 84, 40]]
				]
			: n % 4 === 0
				? [['failure', 0.12, [274, 240, 60, 50]]]
				: [];
		json({ detections });
	});
	return { m, server };
}

// --- the test ---------------------------------------------------------------------------------

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('rendering demo webcam frames');
	const frames = await renderFrames();
	const ocp = mockOctoPrint(frames);
	const ml = mockMlApi(ocp);
	const hooks = [];
	const hookServer = createServer(async (req, res) => {
		hooks.push(((b) => ({ ...b, detection: b.data?.detection }))(JSON.parse(await readBody(req))));
		res.end('ok');
	});
	await Promise.all([listen(ocp.server, OP_PORT), listen(ml.server, ML_PORT), listen(hookServer, HOOK_PORT)]);
	log(`mock OctoPrint ${OP}, mock ML API ${ML}, webhook :${HOOK_PORT}`);

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
			OCM_POLL_INTERVAL_MS: '2000',
			OCM_DETECT_MIN_INTERVAL_S: '1',
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
	const mk4 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: OP, apiKey: 'e2e-octoprint-key', color: 'violet', webcamUrl: `${OP}/webcam/?action=snapshot` })).data;
	assert.ok(mk4?.id, 'printer added');
	for (const u of [
		{ ...OPERATOR, role: 'operator' },
		{ ...VIEWER, role: 'viewer' }
	]) assert.equal((await admin.post('/api/users', u)).status, 201);
	const operator = client();
	const viewer = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);
	await waitFor(async () => (await admin.get('/api/printers/status')).data.some((s) => s.state === 'printing'), 'the printer printing');

	// --- access rules ---------------------------------------------------------------------------
	log('access: frame links, settings, roles');
	const anon = await fetch(`${APP}/api/detect/frame/${'A'.repeat(43)}`);
	assert.equal(anon.status, 404, 'unknown frame token');
	assert.equal((await fetch(`${APP}/api/detect/frame/x`, { method: 'POST', headers: { origin: APP } })).status, 405);
	assert.equal((await fetch(`${APP}/api/detect/frame/${'A'.repeat(43)}`, { method: 'HEAD' })).status, 405, 'HEAD can’t burn a token');
	assert.equal((await fetch(`${APP}/api/printers/${mk4.id}/detect`)).status, 401, 'status needs a session');
	assert.equal((await fetch(`${APP}/api/printers/${mk4.id}/webcam/snapshot`)).status, 401, 'the camera still needs a session');
	assert.equal((await operator.get('/api/settings/detection')).status, 403, 'ML API settings are for admins');
	assert.equal((await viewer.put(`/api/printers/${mk4.id}/detect`, { enabled: true })).status, 403, 'viewers can’t turn it on');
	assert.equal((await viewer.get(`/api/printers/${mk4.id}/detect`)).data.phase, 'off');
	assert.equal((await operator.put(`/api/printers/${mk4.id}/detect`, { enabled: true, onFailure: 'pause', intervalS: 1, skipMinutes: 0 })).status, 200);
	assert.equal((await viewer.get(`/api/printers/${mk4.id}/detect`)).data.phase, 'unconfigured');
	assert.equal((await operator.put(`/api/printers/${mk4.id}/detect`, { intervalS: 0 })).status, 400);
	assert.equal((await admin.put('/api/settings/detection', { mlApiUrl: 'file:///etc' })).status, 400);

	// The webhook hears about suspected failures.
	const hookChannel = await admin.post('/api/settings/notifications/channels', { type: 'webhook', name: 'e2e hook', config: { includeImage: true }, secrets: { url: `http://127.0.0.1:${HOOK_PORT}/detect` } });
	assert.equal(hookChannel.status, 201, JSON.stringify(hookChannel.data));
	const saved = await admin.put('/api/settings/notifications', { publicUrl: APP, rules: [{ name: 'Detections', printers: 'all', events: ['failure.suspected'], channels: [hookChannel.data.channel.id] }] });
	assert.equal(saved.status, 200, JSON.stringify(saved.data));

	// --- browser: admin sets up the ML API --------------------------------------------------------
	browser = await chromium.launch();
	const newPage = async (theme, viewport = { width: 1440, height: 900 }) => {
		const phone = viewport.width < 600;
		const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, colorScheme: theme, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
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
	const shot = async (page, name, el) => {
		await (el ? page.locator(el).screenshot({ path: join(SHOTS, `${name}.png`) }) : page.screenshot({ path: join(SHOTS, `${name}.png`) }));
		log(`  screenshot ${name}.png`);
	};

	log('browser: ML API settings and the round-trip test');
	const dark = await newPage('dark');
	await signIn(dark, ADMIN);
	await dark.goto(`${APP}/settings#failure-detection`);
	await dark.fill('[data-testid=ml-api-url]', ML);
	await dark.fill('[data-testid=ml-api-token]', 'wrong-token');
	await dark.fill('[data-testid=detect-public-url]', APP);
	await dark.click('[data-testid=detect-test]');
	await dark.waitForSelector('[data-testid=detect-test-result]:has-text("401")');
	await dark.fill('[data-testid=ml-api-token]', ML_TOKEN);
	await dark.click('[data-testid=detect-test]');
	await dark.waitForSelector('[data-testid=detect-test-result]:has-text("Round trip")');
	await dark.waitForSelector('[data-testid=detect-test-result]:has-text("detections on the test card")');
	const info = (await admin.get('/api/settings/detection')).data;
	assert.deepEqual({ url: info.mlApiUrl, hasToken: info.hasToken, publicUrl: info.publicUrl }, { url: ML, hasToken: true, publicUrl: APP });
	assert.ok(!JSON.stringify(info).includes(ML_TOKEN), 'the token never comes back');
	debugState = async () => ({ calls: ml.m.calls.map((c) => [c.status, c.again, c.img.slice(-12)]) });
	const testCall = ml.m.calls.at(-1);
	assert.equal(testCall.status, 200, 'the ML API fetched the test frame');
	assert.equal(testCall.again, 404, 'the frame link worked once');
	assert.ok(testCall.jpeg);
	assert.ok(testCall.img.startsWith(`${APP}/api/detect/frame/`));
	assert.ok(!testCall.img.includes(mk4.id), 'links don’t name the printer');
	const audit = (await admin.get('/api/audit?action=settings.detection')).data;
	assert.ok(audit.length >= 1 && !JSON.stringify(audit).includes(ML_TOKEN), 'audited without the token');
	await dark.evaluate(() => document.getElementById('failure-detection')?.scrollIntoView({ block: 'center' }));
	await sleep(300);
	await shot(dark, 'detection-settings', '#failure-detection');

	// --- printing: clean frames, then spaghetti ----------------------------------------------------
	log('printing: clean frames, then spaghetti; expecting a warning, then a pause');
	debugState = async () => ({ status: (await viewer.get(`/api/printers/${mk4.id}/detect`)).data, calls: ml.m.calls.length, failAfter: ml.m.failAfter, op: ocp.s, hooks: hooks.map((h) => h.detection) });
	const before = ml.m.calls.length;
	ml.m.failAfter = before + 14;
	await waitFor(async () => (await viewer.get(`/api/printers/${mk4.id}/detect`)).data.frames >= 10, 'ten analysed frames', { tries: 60 });
	let st = (await viewer.get(`/api/printers/${mk4.id}/detect`)).data;
	assert.equal(st.phase, 'watching');
	assert.equal(st.level, 'ok');
	assert.equal(hooks.length, 0, 'no alerts on clean frames');

	const warn = await waitFor(() => hooks.find((h) => h.detection?.level === 'warning'), 'the warning notification', { tries: 60 });
	assert.equal(warn.event, 'failure.suspected');
	assert.equal(warn.printer.id, mk4.id);
	assert.match(warn.message, /cable-chain-x12\.gcode/);
	const warnJpeg = Buffer.from(warn.image.base64, 'base64');
	assert.ok(warnJpeg[0] === 0xff && warnJpeg[1] === 0xd8 && warnJpeg.length > 5000, 'annotated JPEG attached');
	writeFileSync(join(dataDir, 'warning.jpg'), warnJpeg);

	const failure = await waitFor(() => hooks.find((h) => h.detection?.level === 'failure'), 'the failure notification', { tries: 60 });
	assert.equal(failure.detection.action, 'paused');
	assert.equal(ocp.s.pauses, 1, 'OctoPrint was asked to pause once');
	await waitFor(async () => (await viewer.get(`/api/printers/${mk4.id}/detect`)).data.phase === 'paused', 'the paused phase');
	const pauseAudit = (await admin.get('/api/audit?action=job.pause')).data;
	assert.equal(pauseAudit.length, 1);
	assert.equal(pauseAudit[0].userEmail, 'octo·modern detector');
	assert.equal(pauseAudit[0].printerId, mk4.id);
	const callsAtPause = ml.m.calls.length;
	await sleep(3500);
	assert.equal(ml.m.calls.length, callsAtPause, 'no frames while paused');
	assert.ok(ml.m.calls.slice(before).every((c) => c.status === 200 && c.again === 404 && c.jpeg), 'every frame link served one JPEG, once');
	assert.equal(hooks.filter((h) => h.detection?.level === 'warning').length, 1, 'one warning');
	const frame = await fetch(`${APP}/api/printers/${mk4.id}/detect/frame`, { headers: { cookie: '' } });
	assert.equal(frame.status, 401, 'the annotated frame needs a session');

	st = (await viewer.get(`/api/printers/${mk4.id}/detect`)).data;
	assert.equal(st.level, 'failure');
	assert.equal(st.last.boxes.length, 3);
	assert.ok(st.events.some((e) => e.kind === 'paused'));

	// --- the panel ---------------------------------------------------------------------------------
	log('browser: Camera › Failure detection (dark, light, phone, viewer)');
	// Back to the recommended interval for the pictures (it's paused, so nothing changes).
	assert.equal((await operator.put(`/api/printers/${mk4.id}/detect`, { intervalS: 10, skipMinutes: 5 })).status, 200);
	// The old Failure detection tab's link lands on Camera › Failure detection.
	await dark.goto(`${APP}/p/${mk4.id}?tab=detection`);
	await dark.waitForURL(/tab=camera&view=detection/);
	await dark.waitForSelector('[data-testid=detection-panel][data-level=failure]');
	await dark.waitForFunction(() => document.querySelector('[data-testid=detection-frame]')?.complete);
	await sleep(600);
	await shot(dark, 'detection');

	const light = await newPage('light');
	await signIn(light, ADMIN);
	await light.goto(`${APP}/p/${mk4.id}?tab=camera&view=detection`);
	await light.waitForSelector('[data-testid=detection-panel][data-level=failure]');
	await light.waitForFunction(() => document.querySelector('[data-testid=detection-frame]')?.complete);
	await sleep(600);
	await shot(light, 'detection-light');

	const phone = await newPage('dark', { width: 390, height: 844 });
	await signIn(phone, OPERATOR);
	await phone.goto(`${APP}/p/${mk4.id}?tab=camera&view=detection`);
	await phone.waitForSelector('[data-testid=detection-panel]');
	await phone.waitForFunction(() => document.querySelector('[data-testid=detection-frame]')?.complete);
	await sleep(600);
	await shot(phone, 'mobile-detection');
	const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 0, `no sideways scrolling on a phone (${overflow}px)`);

	const vpage = await newPage('dark');
	await signIn(vpage, VIEWER);
	await vpage.goto(`${APP}/p/${mk4.id}?tab=camera&view=detection`);
	await vpage.waitForSelector('[data-testid=detection-panel]');
	assert.equal(await vpage.locator('[data-testid=false-alarm]').count(), 0, 'viewers get no false-alarm button');
	assert.equal(await vpage.locator('button[role=switch][aria-label="Enable failure detection"]').isDisabled(), true);

	// --- false alarm: the operator resumes and dismisses -------------------------------------------
	log('false alarm: resume, dismiss, no more frames for this print');
	assert.equal((await operator.post(`/api/printers/${mk4.id}/job`, { command: 'resume' })).status, 200);
	await waitFor(async () => (await viewer.get(`/api/printers/${mk4.id}/detect`)).data.phase === 'watching', 'watching again');
	await phone.reload();
	await phone.click('[data-testid=false-alarm]');
	await phone.click('dialog[open] button:has-text("stop watching")');
	await phone.waitForSelector('[data-testid=detection-panel][data-phase=dismissed]');
	const dismissedAt = ml.m.calls.length;
	await sleep(3500);
	assert.ok(ml.m.calls.length <= dismissedAt + 1, 'no frames after a false alarm');
	assert.equal(ocp.s.pauses, 1, 'not paused again');
	const dAudit = (await admin.get('/api/audit?action=detect.dismiss')).data;
	assert.equal(dAudit.length, 1);
	assert.equal(dAudit[0].userEmail, OPERATOR.email);
	assert.equal((await viewer.post(`/api/printers/${mk4.id}/detect/dismiss`)).status, 403);

	// The print ends: the next one is watched again.
	ocp.s.state = 'Operational';
	await waitFor(async () => (await viewer.get(`/api/printers/${mk4.id}/detect`)).data.phase === 'idle', 'idle after the print');
	ocp.s.state = 'Printing';
	ocp.s.spaghetti = false;
	ml.m.failAfter = Infinity;
	ocp.s.startedAt = Date.now() - 20 * 60_000;
	await waitFor(async () => {
		const d = (await viewer.get(`/api/printers/${mk4.id}/detect`)).data;
		return d.phase === 'watching' && d.frames >= 1 && !d.dismissed;
	}, 'a new print watched afresh');

	for (const p of [dark, light, phone, vpage]) assert.deepEqual(p.errors, [], 'no browser errors');
	log(`all failure detection e2e checks passed (${ml.m.calls.length} ML calls, ${hooks.length} notifications)`);
}

async function cleanup(ok) {
	await browser?.close().catch(() => {});
	for (const s of servers) {
		s.closeAllConnections?.();
		s.close();
	}
	if (process.env.E2E_KEEP) {
		log(`E2E_KEEP: app still running on ${APP} (pid ${app?.pid}), data in ${dataDir}`);
		return;
	}
	if (app && app.exitCode === null) {
		const exited = new Promise((r) => app.once('exit', r));
		app.kill();
		// adapter-node waits for open connections on SIGTERM; don't leave it running.
		await Promise.race([exited, sleep(3000)]);
		if (app.exitCode === null) app.kill('SIGKILL');
	}
	if (ok) rmSync(dataDir, { recursive: true, force: true });
}

try {
	await main();
	await cleanup(true);
	process.exit(0);
} catch (err) {
	console.error('✗ e2e failed:', err);
	console.error(JSON.stringify(await debugState().catch((e) => String(e)), (k, v) => (k === 'history' ? v.map((x) => x.score) : v), 1));
	console.error(`  app log: ${join(dataDir, 'app.log')}`);
	await cleanup(false);
	process.exit(1);
}
