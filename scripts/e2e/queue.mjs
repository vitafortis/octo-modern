// End-to-end test of the print queue and the slicer upload API against real OctoPrint
// servers (virtual printers in Docker): dispatch, bed-clear confirmation, copies, a
// cancelled queued print, notifications, restarts, and slicer uploads made with curl
// exactly like PrusaSlicer/OrcaSlicer (libcurl) and Cura (Qt multipart) send them.
//
//   pnpm e2e:queue                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:queue        # leave the containers and app running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:queue  # reuse ./build
//
// Ports (this feature's range): app 3210, OctoPrint 3211–3212, webhook 3215.
// Needs Docker, curl and a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3210);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_BASE = Number(process.env.E2E_OP_PORT_BASE ?? 3211);
const OP_PREFIX = 'octo-modern-queue-e2e-op';
const HOOK_PORT = Number(process.env.E2E_HOOK_PORT ?? 3215);
const OP = [1, 2].map((i) => ({ url: `http://127.0.0.1:${OP_BASE + i - 1}`, key: `ocm-dev-key-${i}` }));
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const opEnv = { ...process.env, OCM_OP_PORT_BASE: String(OP_BASE), OCM_OP_PREFIX: OP_PREFIX };
const devOctoprint = (...args) => execFileSync(join(ROOT, 'scripts/dev-octoprint.sh'), args, { env: opEnv, stdio: 'inherit' });

let app;
let appLog = '';
let browser;
let hookServer;
const hooks = [];
const work = mkdtempSync(join(tmpdir(), 'ocm-e2e-queue-'));
const dataDir = join(work, 'data');
const libDir = join(work, 'library');

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
	return {
		get: (p, o) => call('GET', p, undefined, o),
		post: (p, b, o) => call('POST', p, b ?? {}, o),
		put: (p, b) => call('PUT', p, b),
		patch: (p, b) => call('PATCH', p, b),
		del: (p, b) => call('DELETE', p, b ?? {}),
		get cookie() {
			return cookie;
		}
	};
}

/** G-code the virtual printer takes about `seconds` to print. */
function timedGcode(seconds, label = 'queue e2e') {
	const lines = [`; octo-modern ${label}`, 'G21', 'G90', 'M82', 'G28', 'G92 E0', 'G1 Z0.2 F600'];
	for (let i = 0; i < seconds; i++) {
		lines.push(`G1 X${20 + (i % 10) * 8} Y${20 + Math.floor(i / 10) * 8} E${(i + 1) * 40} F1800`);
		lines.push('G4 P1000');
	}
	lines.push('M84');
	return lines.join('\n') + '\n';
}

async function op(o, method, path, body) {
	const res = await fetch(`${o.url}${path}`, { method, headers: { 'X-Api-Key': o.key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
const opState = async (o) => (await op(o, 'GET', '/api/job')).state;
const opJobFile = async (o) => (await op(o, 'GET', '/api/job')).job?.file?.name ?? null;

/** curl, as PrusaSlicer/OrcaSlicer's libcurl would send it. Returns { status, body }. */
function curl(args) {
	const out = execFileSync('curl', ['-sS', '-o', '-', '-w', '\n%{http_code}', '-A', 'PrusaSlicer/2.8.1', ...args], { encoding: 'utf8' });
	const i = out.lastIndexOf('\n');
	const text = out.slice(0, i);
	let body = text;
	try {
		body = JSON.parse(text);
	} catch {}
	return { status: Number(out.slice(i + 1)), body };
}

/** A PrusaSlicer/OrcaSlicer upload: form fields print, path, then file (libcurl's -F builds the same multipart). */
const slicerUpload = (key, file, name, { print = false, path = '' } = {}) =>
	curl(['-H', `X-Api-Key: ${key}`, '-F', `print=${print}`, '-F', `path=${path}`, '-F', `file=@${file};filename=${name};type=application/octet-stream`, `${APP}/octoprint/api/files/local`]);

/** A Cura OctoPrint-plugin upload: Qt's multipart (quoted boundary, Content-Type first), select+print parts. */
async function curaUpload(key, name, data, { print = true } = {}) {
	const b = 'boundary_.oOo._MjE0NzQ4MzY0Nw==MTg0NDY3NDQwNzM3MDk1NTE2MTU=';
	const part = (disp, type, value) => `--${b}\r\nContent-Type: ${type}\r\nContent-Disposition: ${disp}\r\n\r\n${value}\r\n`;
	const body =
		(print ? part('form-data; name="select"', 'text/plain', 'true') + part('form-data; name="print"', 'text/plain', 'true') : '') +
		part(`form-data; name="file"; filename="${name}"`, 'application/octet-stream', data) +
		`--${b}--\r\n`;
	const res = await fetch(`${APP}/octoprint/api/files/local`, {
		method: 'POST',
		headers: { 'X-Api-Key': key, 'User-Agent': 'Cura/5.8.1 OctoPrintPlugin/3.7.3', 'content-type': `multipart/form-data; boundary="${b}"` },
		body
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(join(libDir, 'Functional'), { recursive: true });
	writeFileSync(join(libDir, 'calibration-cube_PLA.gcode'), timedGcode(10, 'cube'));
	copyFileSync(join(ROOT, 'tests/fixtures/library/prusaslicer.gcode'), join(libDir, 'bracket_PETG_0.15mm_MK4.gcode'));
	copyFileSync(join(ROOT, 'tests/fixtures/library/orcaslicer.gcode'), join(libDir, 'Functional', 'cable-clip-ring_PLA_0.2mm.gcode'));
	const slicerDir = join(work, 'slicer');
	mkdirSync(slicerDir);
	writeFileSync(join(slicerDir, 'phone-stand_PETG.gcode'), timedGcode(45, 'phone stand'));
	writeFileSync(join(slicerDir, 'hook_PLA.gcode'), timedGcode(3, 'hook'));
	// Big enough that curl sends "Expect: 100-continue", like slicers do for real files.
	writeFileSync(join(slicerDir, 'big-plate_PLA.gcode'), timedGcode(3, 'big') + `; ${'x'.repeat(2_000_000)}\n`);

	log('starting two OctoPrint servers with virtual printers');
	devOctoprint('up', '2');

	if (!process.env.E2E_SKIP_BUILD) {
		log('building');
		execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'ignore' });
	}
	const startApp = async () => {
		app = spawn('node', ['build'], {
			cwd: ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', OCM_DATA_DIR: dataDir, OCM_POLL_INTERVAL_MS: '2000', BODY_SIZE_LIMIT: '4G', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' }
		});
		app.stdout.on('data', (d) => (appLog += d));
		app.stderr.on('data', (d) => (appLog += d));
		await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');
	};
	log(`starting octo·modern on ${APP}`);
	await startApp();

	hookServer = createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			hooks.push({ headers: req.headers, body: JSON.parse(body || '{}') });
			res.end('ok');
		});
	});
	await new Promise((r) => hookServer.listen(HOOK_PORT, '127.0.0.1', r));

	// --- setup ----------------------------------------------------------------------------------
	const admin = client();
	assert.equal((await admin.post('/api/auth/setup', ADMIN)).status, 200);
	const mk4 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: OP[0].url, apiKey: OP[0].key, color: 'violet' })).data;
	const voron = (await admin.post('/api/printers', { name: 'Voron 2.4', baseUrl: OP[1].url, apiKey: OP[1].key, color: 'cyan' })).data;
	for (const o of OP) await waitFor(async () => (await opState(o)) === 'Operational', `${o.url} operational`);
	for (const u of [
		{ ...OPERATOR, role: 'operator' },
		{ ...VIEWER, role: 'viewer' }
	])
		assert.equal((await admin.post('/api/users', u)).status, 201);
	const operator = client();
	const viewer = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);
	const lib = (await admin.post('/api/library/sources', { name: 'NAS prints', kind: 'folder', config: { path: libDir }, writable: true })).data;
	assert.ok(lib.id, JSON.stringify(lib));
	const saved = await admin.put('/api/settings/notifications', {
		channels: [{ kind: 'webhook', name: 'e2e hook', on: ['queue.bed_clear_needed'], secrets: { url: `http://127.0.0.1:${HOOK_PORT}/queue` } }]
	});
	assert.equal(saved.status, 200, JSON.stringify(saved.data));
	assert.deepEqual(saved.data.channels[0].on, ['queue.bed_clear_needed']);

	// --- route collisions: octo·modern's /api stays its own ------------------------------------------
	log('routes: /octoprint/api/* is the slicer API; /api/* stays octo·modern’s');
	assert.equal((await fetch(`${APP}/api/version`)).status, 401, 'octo·modern’s /api is session-only (no OctoPrint emulation there)');
	assert.equal((await fetch(`${APP}/api/files/local`, { method: 'POST' })).status, 401);
	assert.equal(curl([`${APP}/octoprint/api/version`]).status, 401, 'no key: 401');
	assert.equal(curl(['-H', 'X-Api-Key: 0123456789ABCDEF0123456789ABCDEF', `${APP}/octoprint/api/version`]).status, 403, 'wrong key: 403, like OctoPrint');
	assert.equal(curl([`${APP}/octoprint/plugin/appkeys/probe`]).status, 404, 'no app-keys workflow: Cura falls back to a pasted key');

	// --- tokens --------------------------------------------------------------------------------
	const mkKey = async (name, upload) => {
		const r = await admin.post('/api/integrations/tokens', { name, scope: 'upload', upload });
		assert.equal(r.status, 201, JSON.stringify(r.data));
		return r.data.token;
	};
	const queueKey = await mkKey('OrcaSlicer → queue (PETG)', { kind: 'queue', tags: ['petg'] });
	const libKey = await mkKey('PrusaSlicer → NAS', { kind: 'library', sourceId: lib.id, folder: 'from-slicer' });
	const voronKey = await mkKey('Cura → Voron', { kind: 'printer', printerId: voron.id, allowPrint: false });
	assert.equal((await admin.post('/api/integrations/tokens', { name: 'x', scope: 'upload', upload: { kind: 'printer', printerId: 'nope' } })).status, 400);
	assert.equal((await operator.post('/api/integrations/tokens', { name: 'x', scope: 'upload', upload: { kind: 'queue' } })).status, 403, 'keys are for admins');
	const bedToken = (await admin.post('/api/integrations/tokens', { name: 'Bed button', bedClear: true })).data.token;
	const plainStatus = (await admin.post('/api/integrations/tokens', { name: 'Homepage' })).data.token;

	log('slicer test connection: GET api/version (PrusaSlicer/OrcaSlicer check "text" starts with OctoPrint)');
	const v = curl(['-H', `X-Api-Key: ${queueKey}`, `${APP}/octoprint/api/version`]);
	assert.equal(v.status, 200);
	assert.ok(v.body.api && v.body.text.startsWith('OctoPrint'), JSON.stringify(v.body));
	assert.equal(curl(['-H', `X-Api-Key: ${queueKey}`, `${APP}/octoprint/api/server`]).body.version, '1.10.3');
	assert.equal(curl(['-H', `X-Api-Key: ${queueKey.slice(4)}`, `${APP}/octoprint/api/version`]).status, 200, 'the key without ocm_ works too');
	assert.equal(curl(['-H', `X-Api-Key: ${queueKey}`, `${APP}/api/printers`]).status, 401, 'an upload key opens nothing else');
	assert.equal(curl(['-H', `Authorization: Bearer ${queueKey}`, `${APP}/api/status`]).status, 401, '…not even the status API');
	for (const p of ['settings', 'printerprofiles', 'printer', 'job', 'connection', 'files/local']) assert.equal(curl(['-H', `X-Api-Key: ${queueKey}`, `${APP}/octoprint/api/${p}`]).status, 200, `Cura reads api/${p}`);

	log('slicer upload → library folder (PrusaSlicer shape, 2 MB with Expect: 100-continue)');
	let up = slicerUpload(libKey, join(slicerDir, 'big-plate_PLA.gcode'), 'big-plate_PLA.gcode', { path: 'plates' });
	assert.equal(up.status, 201, JSON.stringify(up.body));
	assert.equal(up.body.files.local.path, 'from-slicer/plates/big-plate_PLA.gcode');
	assert.equal(readFileSync(join(libDir, 'from-slicer/plates/big-plate_PLA.gcode'), 'utf8'), readFileSync(join(slicerDir, 'big-plate_PLA.gcode'), 'utf8'), 'byte for byte');
	up = slicerUpload(libKey, join(slicerDir, 'hook_PLA.gcode'), 'model.3mf');
	assert.equal(up.status, 415, 'only G-code');

	log('slicer upload → printer (Cura shape, print requested but the key may not start prints)');
	const cura = await curaUpload(voronKey, 'hook_PLA.gcode', readFileSync(join(slicerDir, 'hook_PLA.gcode'), 'utf8'));
	assert.equal(cura.status, 201, JSON.stringify(cura.body));
	assert.equal(cura.body.effectivePrint, false);
	assert.equal((await op(OP[1], 'GET', '/api/files/local/hook_PLA.gcode')).name, 'hook_PLA.gcode', 'on the Voron’s OctoPrint');
	assert.equal(await opState(OP[1]), 'Operational', 'and not printing');

	// --- queue ----------------------------------------------------------------------------------
	log('queue: jobs from the library, a slicer and an upload; nothing starts before the bed is confirmed');
	assert.equal((await admin.post(`/api/printers/${mk4.id}/queue`, { action: 'tags', tags: ['0.4mm', 'PLA'] })).status, 200);
	assert.equal((await admin.post(`/api/printers/${voron.id}/queue`, { action: 'tags', tags: '0.4mm, petg, abs' })).status, 200);
	assert.equal((await operator.post(`/api/printers/${voron.id}/queue`, { action: 'tags', tags: [] })).status, 403, 'tags: admins');
	assert.equal((await viewer.post('/api/queue', { source: 'library', sourceId: lib.id, path: 'calibration-cube_PLA.gcode' })).status, 403, 'viewers only watch');
	const j1 = await operator.post('/api/queue', { source: 'library', sourceId: lib.id, path: 'calibration-cube_PLA.gcode', printerId: mk4.id, copies: 2 });
	assert.equal(j1.status, 201, JSON.stringify(j1.data));
	up = slicerUpload(queueKey, join(slicerDir, 'phone-stand_PETG.gcode'), 'phone-stand_PETG.gcode', { print: true });
	assert.equal(up.status, 201, JSON.stringify(up.body));
	const fd = new FormData();
	fd.set('file', new Blob([timedGcode(3, 'nylon')]), 'gear_PA-CF.gcode');
	const j3 = await fetch(`${APP}/api/queue/upload?tags=nylon,0.6mm&copies=3`, { method: 'POST', headers: { cookie: admin.cookie, origin: APP }, body: fd });
	assert.equal(j3.status, 201, await j3.text());
	await admin.post('/api/queue', { source: 'library', sourceId: lib.id, path: 'bracket_PETG_0.15mm_MK4.gcode', tags: ['petg'] });
	await admin.post('/api/queue', { source: 'library', sourceId: lib.id, path: 'Functional/cable-clip-ring_PLA_0.2mm.gcode', printerId: mk4.id });

	let q = (await viewer.get('/api/queue')).data;
	assert.deepEqual(
		q.jobs.map((j) => [j.name, j.status]),
		[
			['calibration-cube_PLA.gcode', 'queued'],
			['phone-stand_PETG.gcode', 'queued'],
			['gear_PA-CF.gcode', 'queued'],
			['bracket_PETG_0.15mm_MK4.gcode', 'queued'],
			['cable-clip-ring_PLA_0.2mm.gcode', 'queued']
		]
	);
	assert.equal(q.jobs[1].createdBy, 'Key: OrcaSlicer → queue (PETG)');
	assert.ok(q.printers.every((p) => p.awaitingClear), 'beds start unconfirmed');
	await sleep(6000);
	assert.equal(await opState(OP[0]), 'Operational', 'MK4 idle: its bed isn’t confirmed');

	log('reorder (drag/up-down API) and copies');
	const ids = q.jobs.map((j) => j.id);
	assert.equal((await operator.patch(`/api/queue/${ids[4]}`, { move: -1 })).status, 200);
	q = (await admin.get('/api/queue')).data;
	assert.deepEqual(q.jobs.map((j) => j.name).slice(3), ['cable-clip-ring_PLA_0.2mm.gcode', 'bracket_PETG_0.15mm_MK4.gcode']);
	assert.equal((await operator.post('/api/queue/order', { ids: [ids[0], ids[1], ids[2], ids[3], ids[4]] })).status, 200);

	log('browser: confirm the MK4’s bed from the overview card; the Voron’s with a bed-clear token');
	browser = await chromium.launch();
	const newPage = async (theme, viewport = { width: 1440, height: 900 }, mobile = false) => {
		const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
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
	await signIn(dark, OPERATOR);
	await dark.goto(`${APP}/`);
	const banner = dark.locator(`[data-testid="bed-clear-${mk4.id}"]`);
	await banner.waitFor({ timeout: 15_000 });
	await banner.locator('button:has-text("Bed is clear")').click();

	assert.equal(curl(['-X', 'POST', '-H', `Authorization: Bearer ${plainStatus}`, `${APP}/api/status/${voron.id}/bed-clear`]).status, 403, 'a status token without the permission');
	assert.equal(curl(['-H', `Authorization: Bearer ${bedToken}`, `${APP}/api/status/${voron.id}/bed-clear`]).status, 405, 'GET is not a confirmation');
	const bc = curl(['-X', 'POST', '-H', `Authorization: Bearer ${bedToken}`, `${APP}/api/status/${voron.id}/bed-clear`]);
	assert.equal(bc.status, 200, JSON.stringify(bc.body));

	log('dispatch: MK4 takes its library job (transferred), Voron the PETG slicer upload (tags)');
	await waitFor(async () => (await opState(OP[0])).startsWith('Printing'), 'MK4 printing', { every: 300 });
	assert.equal(await opJobFile(OP[0]), 'calibration-cube_PLA.gcode');
	await waitFor(async () => (await opState(OP[1])).startsWith('Printing'), 'Voron printing', { every: 300 });
	assert.equal(await opJobFile(OP[1]), 'phone-stand_PETG.gcode');
	q = (await admin.get('/api/queue')).data;
	const byName = (n) => q.jobs.find((j) => j.name === n);
	await waitFor(async () => {
		q = (await admin.get('/api/queue')).data;
		return byName('calibration-cube_PLA.gcode').status === 'printing' && byName('phone-stand_PETG.gcode').status === 'printing';
	}, 'both jobs printing');
	assert.equal(byName('gear_PA-CF.gcode').status, 'queued', 'no printer has nylon + 0.6mm');
	assert.equal(byName('bracket_PETG_0.15mm_MK4.gcode').status, 'queued', 'the Voron is busy');

	log('copy 1 done: the MK4 waits for a clear bed, and the webhook says so');
	await waitFor(async () => {
		q = (await admin.get('/api/queue')).data;
		return byName('calibration-cube_PLA.gcode').done === 1;
	}, 'copy 1 counted', { tries: 120 });
	let cube = byName('calibration-cube_PLA.gcode');
	assert.equal(cube.status, 'queued');
	assert.equal(cube.runs[0].result, 'success');
	assert.ok(cube.runs[0].printId, 'linked to its history entry');
	const entry = (await admin.get(`/api/history/${cube.runs[0].printId}`)).data;
	assert.equal(entry.file, 'calibration-cube_PLA.gcode');
	assert.equal(entry.result, 'success');
	assert.equal(entry.startedBy, OPERATOR.name, 'history credits who queued it');
	assert.ok(q.printers.find((p) => p.printerId === mk4.id).awaitingClear);
	const hook = await waitFor(() => hooks.find((h) => h.body.event === 'queue.bed_clear_needed'), 'the bed-clear webhook');
	assert.equal(hook.body.printer.name, 'Prusa MK4');
	assert.match(hook.body.message, /calibration-cube_PLA\.gcode/);
	await sleep(5000);
	assert.equal(await opState(OP[0]), 'Operational', 'copy 2 waits for the bed');

	// Screenshots while the Voron prints and the MK4 waits.
	const shot = async (page, name) => {
		await page.screenshot({ path: join(SHOTS, `${name}.png`) });
		log(`  screenshot ${name}.png`);
	};
	await dark.goto(`${APP}/queue`);
	await dark.waitForSelector('[data-testid="queue-job"]');
	await dark.waitForTimeout(800);
	await shot(dark, 'queue');
	await dark.goto(`${APP}/p/${mk4.id}?tab=queue`);
	await dark.locator('button:has-text("Bed is clear")').first().waitFor();
	await dark.waitForTimeout(800);
	await shot(dark, 'queue-bed-clear');
	const light = await newPage('light');
	await signIn(light, ADMIN);
	await light.goto(`${APP}/queue`);
	await light.waitForSelector('[data-testid="queue-job"]');
	await light.waitForTimeout(800);
	await shot(light, 'queue-light');
	await light.goto(`${APP}/integrations#slicer`);
	await light.waitForSelector('[data-testid="upload-destination"]');
	await light.locator('#slicer').scrollIntoViewIfNeeded();
	await light.waitForTimeout(500);
	await light.locator('#slicer').screenshot({ path: join(SHOTS, 'slicer-keys.png') });
	log('  screenshot slicer-keys.png');
	const phone = await newPage('dark', { width: 390, height: 844 }, true);
	await signIn(phone, OPERATOR);
	await phone.goto(`${APP}/queue`);
	await phone.waitForSelector('[data-testid="queue-job"]');
	await phone.waitForTimeout(800);
	const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	assert.ok(overflow <= 0, `no horizontal scroll at 390 px (${overflow}px)`);
	await shot(phone, 'mobile-queue');
	await phone.goto(`${APP}/p/${mk4.id}`);
	const phoneBanner = phone.locator(`[data-testid="bed-clear-${mk4.id}"] button:has-text("Bed is clear")`);
	await phoneBanner.waitFor();
	const box = await phoneBanner.boundingBox();
	assert.ok(box && box.y + box.height <= 844 && box.height >= 36, `"Bed is clear" in reach on a phone (${JSON.stringify(box)})`);
	await shot(phone, 'mobile-queue-bed-clear');

	log('copy 2: confirmed from the phone, then cancelled → job failed, MK4 held');
	await phoneBanner.click();
	await waitFor(async () => (await opState(OP[0])).startsWith('Printing'), 'copy 2 printing', { every: 300 });
	await waitFor(async () => (await admin.get('/api/queue')).data.jobs.find((j) => j.name === 'calibration-cube_PLA.gcode').status === 'printing', 'copy 2 tracked');
	assert.equal((await admin.post(`/api/printers/${mk4.id}/queue`, { action: 'bed-clear' })).status, 409, 'can’t confirm the bed mid-print');
	await sleep(2000);
	assert.equal((await operator.post(`/api/printers/${mk4.id}/job`, { command: 'cancel', confirm: true })).status, 200);
	await waitFor(async () => {
		q = (await admin.get('/api/queue')).data;
		return byName('calibration-cube_PLA.gcode').status === 'failed';
	}, 'the job failed', { tries: 120 });
	cube = byName('calibration-cube_PLA.gcode');
	assert.equal(cube.error, 'Cancelled');
	assert.equal(cube.done, 1);
	const mk4q = q.printers.find((p) => p.printerId === mk4.id);
	assert.ok(mk4q.held && /cancelled/.test(mk4q.heldReason), JSON.stringify(mk4q));
	assert.equal((await operator.post(`/api/printers/${mk4.id}/queue`, { action: 'bed-clear' })).status, 200);
	await sleep(5000);
	assert.equal(await opState(OP[0]), 'Operational', 'held: the clip (next MK4 job) doesn’t start');

	log('restart: the queue, holds and bed state survive');
	app.kill();
	await new Promise((r) => app.once('exit', r));
	await startApp();
	assert.equal((await admin.post('/api/auth/login', ADMIN)).status, 200);
	q = (await admin.get('/api/queue')).data;
	assert.equal(byName('calibration-cube_PLA.gcode').status, 'failed');
	assert.ok(q.printers.find((p) => p.printerId === mk4.id).held);
	assert.equal(q.jobs.length, 5);

	log('the Voron’s print ends: its job is done; the MK4 resumes after a requeue');
	await waitFor(async () => {
		q = (await admin.get('/api/queue')).data;
		return byName('phone-stand_PETG.gcode').status === 'done';
	}, 'phone stand done (tracked across the restart)', { tries: 160 });
	assert.equal(byName('phone-stand_PETG.gcode').runs[0].result, 'success');
	assert.equal((await operator.patch(`/api/queue/${cube.id}`, { requeue: true })).status, 200);
	assert.equal((await operator.post(`/api/printers/${mk4.id}/queue`, { action: 'release' })).status, 200);
	await waitFor(async () => (await opState(OP[0])).startsWith('Printing'), 'MK4 printing again', { every: 300 });
	assert.equal(await opJobFile(OP[0]), 'cable-clip-ring_PLA_0.2mm.gcode', 'the next MK4 job in order (the requeued cube went to the end)');
	assert.equal((await operator.del(`/api/queue/${byName('cable-clip-ring_PLA_0.2mm.gcode').id}`)).status, 409, 'removing a running job asks first');
	await op(OP[0], 'POST', '/api/job', { command: 'cancel' });

	log('pause: nothing new starts');
	assert.equal((await operator.post('/api/queue/pause', { paused: true })).status, 200);
	assert.equal((await viewer.post('/api/queue/pause', { paused: false })).status, 403);
	assert.ok((await admin.get('/api/queue')).data.paused);

	const audit = (await admin.get('/api/audit?action=queue.&limit=200')).data;
	const actions = new Set((audit.items ?? audit).map((a) => a.action));
	for (const a of ['queue.add', 'queue.start', 'queue.bed_clear', 'queue.edit', 'queue.release', 'queue.pause', 'queue.tags']) assert.ok(actions.has(a), `audited: ${a}`);
	for (const p of [dark, light, phone]) assert.deepEqual(p.errors, [], 'no browser errors');
	log('✓ queue e2e passed');
}

async function cleanup(ok) {
	await browser?.close().catch(() => {});
	hookServer?.closeAllConnections?.();
	hookServer?.close();
	writeFileSync(join(work, 'app.log'), appLog);
	if (process.env.E2E_KEEP) {
		log(`E2E_KEEP: app still running on ${APP} (pid ${app?.pid}), data in ${dataDir}`);
		return;
	}
	app?.kill();
	try {
		devOctoprint('down');
	} catch {}
	if (ok) rmSync(work, { recursive: true, force: true });
}

try {
	await main();
	await cleanup(true);
	process.exit(0);
} catch (err) {
	console.error('✗ e2e failed:', err);
	console.error(`  app log: ${join(work, 'app.log')}`);
	await cleanup(false);
	process.exit(1);
}
