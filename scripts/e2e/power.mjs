// End-to-end test of smart plug power control, against local mocks only: two mock OctoPrint
// servers whose printers are powered by a mock Shelly Gen2 (Digest login) and a mock Tasmota.
// No real plug, printer or service is contacted.
//
//   pnpm e2e:power                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:power        # leave the app and mocks running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:power  # reuse ./build
//
// Ports 3230–3236: app 3230, OctoPrint 3231–3232, plugs 3233–3234, camera 3235, webhook 3236.
// Needs a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMjpegSource } from '../mjpeg-source.mjs';
import { startMockPlug } from './mock-plugs.mjs';
import { startMockOctoPrint } from './mock-octoprint.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = 3230;
const APP = `http://127.0.0.1:${APP_PORT}`;
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };
const SHELLY_PASSWORD = 'shelly-e2e-pass';
const TASMOTA_PASSWORD = 'tasmota-e2e-pass';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

let app;
let browser;
const closers = [];
const hooks = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-power-'));

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
	const call = async (method, path, body) => {
		const res = await fetch(`${APP}${path}`, {
			method,
			redirect: 'manual',
			headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), origin: APP },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const set = res.headers.get('set-cookie');
		if (set) cookie = set.split(';')[0];
		const text = await res.text();
		let data = null;
		try {
			data = JSON.parse(text);
		} catch {}
		return { status: res.status, data, text };
	};
	return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p, {}) };
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting mock plugs, mock OctoPrint servers and a test camera');
	const shelly = await startMockPlug({ kind: 'shelly2', port: 3233, auth: { username: 'admin', password: SHELLY_PASSWORD }, on: false, watts: (on) => (on ? 38.6 : 0) });
	const tasmota = await startMockPlug({ kind: 'tasmota', port: 3234, auth: { username: 'admin', password: TASMOTA_PASSWORD }, on: true, watts: (on) => (on ? 112.4 : 0) });
	const mk4Op = await startMockOctoPrint({ port: 3231, apiKey: 'mk4-e2e-key', powered: () => shelly.state.on, printSeconds: 40, coolPerSecond: 0.3 });
	const voronOp = await startMockOctoPrint({ port: 3232, apiKey: 'voron-e2e-key', powered: () => tasmota.state.on, printSeconds: 6, coolPerSecond: 0.35 });
	const cam = await startMjpegSource({ port: 3235, host: '127.0.0.1' });
	const hookServer = createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			hooks.push(JSON.parse(body));
			res.end('ok');
		});
	});
	await new Promise((r) => hookServer.listen(3236, '127.0.0.1', r));
	closers.push(shelly.close, tasmota.close, mk4Op.close, voronOp.close, cam.close, () => (hookServer.closeAllConnections(), new Promise((r) => hookServer.close(r))));
	// The Voron is on and connected; the MK4 is off.
	await fetch(`${voronOp.url}/api/connection`, { method: 'POST', headers: { 'x-api-key': 'voron-e2e-key', 'content-type': 'application/json' }, body: JSON.stringify({ command: 'connect' }) });

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
			OCM_ADMIN_EMAIL: ADMIN.email,
			OCM_ADMIN_PASSWORD: ADMIN.password,
			OCM_ADMIN_NAME: ADMIN.name,
			NODE_OPTIONS: '--disable-warning=ExperimentalWarning'
		}
	});
	let appLog = '';
	app.stdout.on('data', (d) => (appLog += d));
	app.stderr.on('data', (d) => (appLog += d));
	app.on('exit', (code, signal) => (appLog += `\n[app exited: ${code ?? signal}]\n`));
	process.on('exit', () => {
		try {
			writeFileSync(join(dataDir, 'app.log'), appLog);
		} catch {}
	});
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');

	const admin = client();
	assert.equal((await admin.post('/api/auth/login', ADMIN)).status, 200);
	const mk4 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: mk4Op.url, apiKey: 'mk4-e2e-key', color: 'violet', webcamUrl: `${cam.url}/?action=stream` })).data;
	const voron = (await admin.post('/api/printers', { name: 'Voron 2.4', baseUrl: voronOp.url, apiKey: 'voron-e2e-key', color: 'cyan', webcamUrl: `${cam.url}/?action=stream` })).data;
	for (const u of [
		{ ...OPERATOR, role: 'operator' },
		{ ...VIEWER, role: 'viewer' }
	]) assert.equal((await admin.post('/api/users', u)).status, 201);
	const operator = client();
	const viewer = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);
	const stateOf = async (id) => (await admin.get('/api/printers/status')).data.find((s) => s.id === id)?.state;
	const plugOf = async (c, id) => (await c.get('/api/power')).data.find((p) => p.printerId === id);
	const audits = async (action) => (await admin.get(`/api/audit?action=${action}`)).data;
	await waitFor(async () => (await stateOf(voron.id)) === 'operational' && (await stateOf(mk4.id)) === 'disconnected', 'Voron ready, MK4 unpowered');

	const saved = await admin.put('/api/settings/notifications', { channels: [{ kind: 'webhook', name: 'e2e hook', on: ['power.on', 'power.off'], secrets: { url: 'http://127.0.0.1:3236/power' } }] });
	assert.equal(saved.status, 200, saved.text);
	assert.deepEqual(saved.data.channels[0].on, ['power.on', 'power.off']);

	// --- setup: admins only, secrets never come back --------------------------------------------
	log('plug setup: admins only, sealed credentials, Test');
	const mk4Plug = { kind: 'shelly', label: 'Desk plug', config: { url: shelly.url, channel: 0, generation: 'auto' }, secrets: { username: 'admin', password: SHELLY_PASSWORD }, settings: { autoConnect: true } };
	assert.equal((await operator.put(`/api/printers/${mk4.id}/power/config`, mk4Plug)).status, 403);
	assert.equal((await operator.get(`/api/printers/${mk4.id}/power/config`)).status, 403);
	assert.equal((await operator.post(`/api/printers/${mk4.id}/power/test`, mk4Plug)).status, 403);
	const badTest = await admin.post(`/api/printers/${mk4.id}/power/test`, { ...mk4Plug, secrets: { password: 'wrong' } });
	assert.equal(badTest.status, 502);
	assert.equal(badTest.data.code, 'AUTH');
	const goodTest = await admin.post(`/api/printers/${mk4.id}/power/test`, mk4Plug);
	assert.equal(goodTest.status, 200, goodTest.text);
	assert.equal(goodTest.data.reading.on, false);
	assert.equal(shelly.state.on, false, 'Test never switches');
	assert.equal((await admin.put(`/api/printers/${mk4.id}/power/config`, { ...mk4Plug, config: { url: 'http://admin:pw@plug.lan' } })).status, 400);
	const put = await admin.put(`/api/printers/${mk4.id}/power/config`, mk4Plug);
	assert.equal(put.status, 200, put.text);
	assert.ok(!put.text.includes(SHELLY_PASSWORD) && !(await admin.get(`/api/printers/${mk4.id}/power/config`)).text.includes(SHELLY_PASSWORD), 'the password never comes back');
	assert.ok(!(await admin.get('/api/power')).text.includes(shelly.url.replace('http://', '')), 'no plug addresses in the status API');
	// Editing without retyping the password keeps it.
	assert.equal((await admin.put(`/api/printers/${mk4.id}/power/config`, { ...mk4Plug, secrets: { username: 'admin' } })).status, 200);
	assert.equal((await admin.post(`/api/printers/${mk4.id}/power/test`, { ...mk4Plug, secrets: { username: 'admin' } })).status, 200, 'stored password used');
	const voronPlug = { kind: 'tasmota', config: { url: tasmota.url, channel: 0 }, secrets: { username: 'admin', password: TASMOTA_PASSWORD }, settings: { autoOff: { enabled: true, hotendC: 50, idleMinutes: 1 } } };
	assert.equal((await admin.put(`/api/printers/${voron.id}/power/config`, voronPlug)).status, 200);
	const vInfo = await waitFor(() => plugOf(viewer, voron.id), 'viewer sees the Voron plug');
	assert.equal(vInfo.reading.on, true);
	assert.equal(vInfo.reading.powerW, 112.4);
	assert.equal((await viewer.post(`/api/printers/${mk4.id}/power`, { action: 'on' })).status, 403, 'viewers can’t switch');

	// --- on: plug, then OctoPrint connects by itself ----------------------------------------------
	log('power on → auto-connect');
	const on = await operator.post(`/api/printers/${mk4.id}/power`, { action: 'on' });
	assert.equal(on.status, 200, on.text);
	assert.equal(shelly.state.on, true);
	await waitFor(async () => (await stateOf(mk4.id)) === 'operational', 'MK4 connected after power-on', { tries: 60 });
	assert.ok(mk4Op.state.connects >= 1);
	await waitFor(() => hooks.some((h) => h.event === 'power.on' && h.printer.name === 'Prusa MK4'), 'power.on webhook');
	assert.match(hooks.find((h) => h.event === 'power.on').message, /powered on by Otto Operator/);
	await waitFor(async () => (await audits('power.autoconnect')).some((e) => /connected/.test(e.detail)), 'auto-connect audited', { tries: 30 });

	// --- off: hot needs one confirmation, printing two ------------------------------------------------
	log('power off: confirmations');
	await fetch(`${mk4Op.url}/__mock/heat?tool=140&bed=55`);
	await sleep(2500);
	let r = await operator.post(`/api/printers/${mk4.id}/power`, { action: 'off' });
	assert.equal(r.status, 409);
	assert.equal(r.data.stage, 'hot');
	assert.equal(r.data.confirmField, 'confirm');
	assert.equal(shelly.state.on, true);
	r = await operator.post(`/api/printers/${mk4.id}/power`, { action: 'off', confirm: true });
	assert.equal(r.status, 200, r.text);
	assert.equal(shelly.state.on, false);
	assert.ok((await audits('power.off')).some((e) => /while hot/.test(e.detail) && e.userEmail === OPERATOR.email));
	await waitFor(() => hooks.some((h) => h.event === 'power.off'), 'power.off webhook');

	await operator.post(`/api/printers/${mk4.id}/power`, { action: 'on' });
	await waitFor(() => mk4Op.state.state === 'Operational', 'MK4 connected again', { tries: 60 });
	await waitFor(async () => (await stateOf(mk4.id)) === 'operational', 'MK4 ready again', { tries: 60 });
	await fetch(`${mk4Op.url}/__mock/print?file=gearbox-housing.gcode`);
	await waitFor(async () => (await stateOf(mk4.id)) === 'printing', 'MK4 printing');
	r = await operator.post(`/api/printers/${mk4.id}/power`, { action: 'off' });
	assert.equal(r.data.stage, 'printing');
	r = await operator.post(`/api/printers/${mk4.id}/power`, { action: 'off', confirm: true });
	assert.equal(r.status, 409, 'a printing printer always needs the second confirmation');
	assert.equal(r.data.stage, 'printing-final');
	assert.equal(r.data.confirmField, 'confirmPrinting');
	r = await operator.post(`/api/printers/${mk4.id}/power`, { action: 'off', confirmPrinting: true });
	assert.equal(r.data.stage, 'printing');
	assert.equal(shelly.state.on, true, 'still printing');

	// --- browser ------------------------------------------------------------------------------------
	browser = await chromium.launch();
	const newPage = async (theme, width = 1440, height = 900) => {
		const mobile = width < 640 ? { hasTouch: true, isMobile: true } : {};
		const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: width < 640 ? 2 : 1, colorScheme: theme, ...mobile });
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
	const shot = async (page, name) => {
		await page.screenshot({ path: join(SHOTS, `${name}.png`) });
		log(`  screenshot ${name}.png`);
	};

	log('browser: cutting power mid-print takes two confirmations');
	const opPage = await newPage('dark');
	await signIn(opPage, OPERATOR);
	await opPage.goto(`${APP}/p/${mk4.id}`);
	await opPage.waitForSelector('[data-testid=power-card] [data-testid=plug-state]:has-text("On")');
	await opPage.click('header [data-testid=power-off]');
	await opPage.waitForSelector('dialog[open] >> text=Prusa MK4 is printing');
	await opPage.click('dialog[open] button:has-text("Continue")');
	await opPage.waitForSelector('dialog[open] >> text=Cut the power mid-print?');
	await sleep(400);
	await shot(opPage, 'power-confirm');
	await opPage.click('dialog[open] button:has-text("Cut power now")');
	await waitFor(() => !shelly.state.on, 'MK4 plug off');
	assert.ok((await audits('power.off')).some((e) => /during a print of gearbox-housing.gcode .*confirmed twice/.test(e.detail)));
	await opPage.waitForSelector('[data-testid=power-card] [data-testid=plug-state]:has-text("Off")');

	// --- auto power-on when a print is sent to an off printer ------------------------------------------
	log('auto power-on: printing a file on an off printer switches it on first');
	assert.equal((await admin.put(`/api/printers/${mk4.id}/power/config`, { ...mk4Plug, secrets: { username: 'admin' }, settings: { autoConnect: true, autoOn: true } })).status, 200);
	await waitFor(async () => (await stateOf(mk4.id)) !== 'printing', 'MK4 no longer printing');
	r = await operator.post(`/api/printers/${mk4.id}/files/select`, { origin: 'local', path: 'benchy.gcode', print: true });
	assert.equal(r.status, 200, r.text);
	assert.equal(shelly.state.on, true);
	assert.equal(mk4Op.state.state, 'Printing');
	assert.ok((await audits('power.auto_on')).some((e) => /to print benchy.gcode/.test(e.detail)));
	await operator.post(`/api/printers/${mk4.id}/job`, { command: 'cancel', confirm: true });

	// --- auto power-off after a print, with "Keep on" -----------------------------------------------------
	log('auto power-off: countdown after a print, Keep on, and a new print cancelling it');
	await fetch(`${voronOp.url}/__mock/print?file=voron-cube.gcode`);
	await waitFor(async () => (await plugOf(admin, voron.id))?.countdown, 'Voron countdown armed', { tries: 60 });
	const cd = (await plugOf(admin, voron.id)).countdown;
	assert.equal(cd.targetC, 50);
	assert.ok(cd.offAt - cd.since === 60_000);

	const dark = await newPage('dark');
	await signIn(dark, ADMIN);
	await dark.goto(`${APP}/`);
	await dark.waitForSelector('[data-testid=power-strip] [data-testid=auto-off]');
	await dark.waitForSelector('[data-testid=glyph-off]', { state: 'detached' }).catch(() => {});
	// Sidebar context menu on the Voron.
	await dark.click(`aside a[href="/p/${voron.id}"]`, { button: 'right' });
	await dark.waitForSelector('[data-testid=power-menu]');
	await sleep(900);
	await shot(dark, 'power-overview');
	await dark.keyboard.press('Escape');
	await dark.goto(`${APP}/p/${voron.id}`);
	await dark.waitForSelector('[data-testid=power-card] [data-testid=auto-off]');
	await sleep(1200);
	await shot(dark, 'power');
	const light = await newPage('light');
	await signIn(light, ADMIN);
	await light.goto(`${APP}/p/${voron.id}`);
	await light.waitForSelector('[data-testid=power-card] [data-testid=auto-off]');
	await sleep(1200);
	await shot(light, 'power-light');
	await light.close();
	// Keep on, from the operator's overview card.
	await opPage.goto(`${APP}/`);
	await opPage.click('[data-testid=power-strip] [data-testid=auto-off] button:has-text("Keep on")');
	await waitFor(async () => !(await plugOf(admin, voron.id)).countdown, 'countdown cancelled');
	assert.ok((await audits('power.keep_on')).some((e) => e.userEmail === OPERATOR.email));
	assert.equal(tasmota.state.on, true);

	// A new print cancels a countdown.
	await fetch(`${voronOp.url}/__mock/print?file=voron-cube-2.gcode`);
	await waitFor(async () => (await plugOf(admin, voron.id))?.countdown, 'armed again', { tries: 60 });
	await fetch(`${voronOp.url}/__mock/print?file=voron-cube-3.gcode`);
	await waitFor(async () => (await audits('power.auto_off.cancelled')).some((e) => e.detail === 'A new print started'), 'cancelled by the new print', { tries: 30 });
	// Idle time 0: off as soon as the hotend is below 50 °C (settings changed mid-print take effect for the next end).
	assert.equal((await admin.put(`/api/printers/${voron.id}/power/config`, { ...voronPlug, secrets: { username: 'admin' }, settings: { autoOff: { enabled: true, hotendC: 50, idleMinutes: 0 } } })).status, 200);
	await fetch(`${voronOp.url}/__mock/print?file=voron-cube-4.gcode`);
	await waitFor(() => !tasmota.state.on, 'Voron powered off by itself', { tries: 90 });
	assert.ok(voronOp.state.tool < 50, `hotend cooled first (${voronOp.state.tool.toFixed(1)} °C)`);
	assert.ok((await audits('power.auto_off')).some((e) => e.action === 'power.auto_off' && e.userEmail === null));
	await waitFor(() => hooks.some((h) => h.event === 'power.off' && h.printer.name === 'Voron 2.4' && /by octo·modern/.test(h.message)), 'auto power-off webhook');

	// --- setup dialog --------------------------------------------------------------------------------------
	log('browser: the setup dialog');
	await dark.goto(`${APP}/p/${mk4.id}`);
	await dark.click('[data-testid=power-card] button[aria-label="Smart plug settings"]');
	await dark.waitForSelector('dialog[open] [data-testid=power-test]');
	assert.equal(await dark.inputValue('dialog[open] input[name=password]'), '', 'password not sent to the browser');
	assert.match(await dark.getAttribute('dialog[open] input[name=password]', 'placeholder'), /saved/);
	await dark.click('dialog[open] [role=switch][aria-label="Power off after a print"]');
	await dark.click('dialog[open] [data-testid=power-test]');
	await dark.waitForSelector('dialog[open] [data-testid=power-test-result]:has-text("Reached it")');
	await sleep(300);
	await shot(dark, 'power-config');
	const [saveRes] = await Promise.all([dark.waitForResponse((r) => r.url().endsWith('/power/config') && r.request().method() === 'PUT'), dark.click('dialog[open] [data-testid=power-save]')]);
	assert.equal(saveRes.status(), 200, await saveRes.text());
	await dark.waitForSelector('dialog[open]', { state: 'detached' });
	assert.equal((await admin.get(`/api/printers/${mk4.id}/power/config`)).data.plug.settings.autoOff.enabled, true);
	assert.equal((await admin.post(`/api/printers/${mk4.id}/power/test`, { ...mk4Plug, secrets: { username: 'admin' } })).status, 200, 'saving from the UI kept the password');

	// Phones: the power buttons stay in the printer header, the card in the one-column dashboard.
	log('browser: 390 px phone');
	const phone = await newPage('dark', 390, 844);
	await signIn(phone, OPERATOR);
	await phone.goto(`${APP}/p/${mk4.id}`);
	await phone.waitForSelector('[data-testid=power-card] [data-testid=plug-state]:has-text("On")');
	const offBtn = await phone.locator('header [data-testid=power-off]').boundingBox();
	assert.ok(offBtn && offBtn.height >= 44 && offBtn.x + offBtn.width <= 390, `header power button reachable on a phone (${JSON.stringify(offBtn)})`);
	await phone.locator('[data-testid=power-card]').scrollIntoViewIfNeeded();
	assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
	await sleep(600);
	await shot(phone, 'power-phone');
	assert.deepEqual(phone.errors, [], 'no browser errors on the phone');

	// Viewers see the state but get no buttons.
	const viewPage = await newPage('dark');
	await signIn(viewPage, VIEWER);
	await viewPage.goto(`${APP}/p/${mk4.id}`);
	await viewPage.waitForSelector('[data-testid=power-card]');
	assert.equal(await viewPage.locator('[data-testid=power-on], [data-testid=power-off]').count(), 0);

	// Everything audited.
	const actions = new Set((await audits('power.')).map((e) => e.action));
	for (const a of ['power.config.create', 'power.config.update', 'power.test', 'power.on', 'power.off', 'power.autoconnect', 'power.auto_on', 'power.auto_off.armed', 'power.auto_off.cancelled', 'power.keep_on', 'power.auto_off']) {
		assert.ok(actions.has(a), `audited: ${a}`);
	}
	for (const p of [dark, opPage, viewPage]) assert.deepEqual(p.errors, [], 'no browser errors');
	log('all power e2e checks passed');
}

async function cleanup(ok) {
	await browser?.close().catch(() => {});
	if (process.env.E2E_KEEP) {
		log(`E2E_KEEP: app still running on ${APP} (pid ${app?.pid}), data in ${dataDir}`);
		return;
	}
	app?.kill();
	for (const c of closers) await Promise.resolve(c()).catch(() => {});
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
