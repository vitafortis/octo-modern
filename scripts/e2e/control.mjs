// End-to-end test of the Control and Terminal tabs against a real OctoPrint (virtual printer in Docker).
//
//   pnpm e2e:control                  # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:control       # leave the container and app running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:control # reuse ./build
//
// OctoPrint echoes every line it sends to the printer into its terminal log ("Send: G0 X10 F6000"),
// so the checks read the log through octo·modern to see exactly what each control produced.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3150);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_BASE = Number(process.env.E2E_OP_PORT_BASE ?? 5131);
const OP_PREFIX = process.env.E2E_OP_PREFIX ?? 'octo-modern-e2e-ctl-op';
const OP = { url: `http://127.0.0.1:${OP_BASE}`, key: 'ocm-dev-key-1' };
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const opEnv = { ...process.env, OCM_OP_PORT_BASE: String(OP_BASE), OCM_OP_PREFIX: OP_PREFIX, OCM_OP_CONNECT: '0' };
const devOctoprint = (...args) => execFileSync(join(ROOT, 'scripts/dev-octoprint.sh'), args, { env: opEnv, stdio: 'inherit' });

let app;
let browser;
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-ctl-'));

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
		return { status: res.status, data: await res.json().catch(() => null) };
	};
	return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) };
}

const op = (path, body) =>
	fetch(`${OP.url}${path}`, {
		method: body ? 'POST' : 'GET',
		headers: { 'X-Api-Key': OP.key, ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined
	});

async function opState() {
	return (await (await op('/api/job')).json()).state;
}

function slowGcode() {
	const lines = ['G21', 'G90', 'M82', 'G28'];
	for (let i = 0; i < 400; i++) lines.push(`G1 X${100 + (i % 20)} Y${100 + (i % 7)} F1200`, 'G4 P150');
	return lines.join('\n') + '\n';
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting OctoPrint with a virtual printer');
	devOctoprint('up', '1');
	// Two extruders, an inverted Y axis and a 250×210×220 volume: the Control tab must follow all of it.
	assert.equal((await op('/api/settings', { plugins: { virtual_printer: { numExtruders: 2 } } })).status, 200);
	const prof = await op('/api/printerprofiles', {
		profile: {
			id: 'e2e_idex',
			name: 'E2E IDEX',
			model: 'Two-tool test rig',
			volume: { width: 250, depth: 210, height: 220, formFactor: 'rectangular', origin: 'lowerleft' },
			heatedBed: true,
			heatedChamber: true,
			extruder: { count: 2, offsets: [[0, 0], [0, 0]], nozzleDiameter: 0.4, sharedNozzle: false },
			axes: { x: { speed: 6000, inverted: false }, y: { speed: 6000, inverted: true }, z: { speed: 200, inverted: false }, e: { speed: 300, inverted: false } }
		}
	});
	assert.equal(prof.status, 200, await prof.text());
	assert.equal((await op('/api/connection', { command: 'connect', port: 'VIRTUAL', baudrate: 0, printerProfile: 'e2e_idex' })).status, 204);

	if (!process.env.E2E_SKIP_BUILD) {
		log('building');
		execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'ignore' });
	}
	log(`starting octo·modern on ${APP}`);
	app = spawn('node', ['build'], {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', OCM_DATA_DIR: dataDir, OCM_POLL_INTERVAL_MS: '3000', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' }
	});
	let appLog = '';
	app.stdout.on('data', (d) => (appLog += d));
	app.stderr.on('data', (d) => (appLog += d));
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');

	const admin = client();
	assert.equal((await admin.post('/api/auth/setup', ADMIN)).status, 200);
	const p = (await admin.post('/api/printers', { name: 'Prusa XL', baseUrl: OP.url, apiKey: OP.key, color: 'violet' })).data;
	for (const u of [
		{ ...OPERATOR, role: 'operator' },
		{ ...VIEWER, role: 'viewer' }
	]) assert.equal((await admin.post('/api/users', u)).status, 201);
	const operator = client();
	const viewer = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);
	await waitFor(async () => (await admin.get('/api/printers/status')).data.find((s) => s.id === p.id)?.state === 'operational', 'operational');
	const base = `/api/printers/${p.id}`;

	// Keep the printer live (push connection) so the terminal log is current.
	const sse = new AbortController();
	fetch(`${APP}${base}/events`, { headers: { cookie: (await loginCookie(ADMIN)) }, signal: sse.signal })
		.then(async (r) => {
			for await (const _ of r.body);
		})
		.catch(() => {});

	const logs = async () => (await admin.get(`${base}/state`)).data.logs;
	/** Runs `fn` and waits until the log has more lines matching `re` than before. */
	async function expectLog(re, fn, label = String(re)) {
		const count = (ls) => ls.filter((l) => re.test(l)).length;
		const before = count(await logs());
		const res = await fn();
		await waitFor(async () => count(await logs()) > before, `log line ${label}`, { tries: 40, every: 250 });
		return res;
	}
	await waitFor(async () => (await logs()).length > 0, 'terminal lines');

	// --- the control API ------------------------------------------------------------------------
	log('control info: profile and custom controls');
	const info = (await viewer.get(`${base}/control`)).data;
	assert.equal(info.profile.name, 'E2E IDEX');
	assert.equal(info.profile.extruders, 2);
	assert.equal(info.profile.axes.y.inverted, true);
	assert.equal(info.profile.heatedChamber, true);
	assert.deepEqual(info.profile.volume, { width: 250, depth: 210, height: 220, formFactor: 'rectangular', origin: 'lowerleft' });
	assert.deepEqual(info.controls.map((c) => [c.kind, c.name, c.children.length]), [['section', 'Lights', 2], ['section', 'Diagnostics', 2]]);

	log('jog, home, fan, feed and flow rate, motors off, tool, extrude produce the expected G-code');
	const ctl = (body) => operator.post(`${base}/control`, body);
	const ok = async (body) => {
		const r = await ctl(body);
		assert.equal(r.status, 200, `${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.data)}`);
	};
	await expectLog(/^Send: G0 X10(\.0+)? F6000/, () => ok({ action: 'jog', x: 10 }));
	await expectLog(/^Send: G0 Y-1(\.0+)? Z0?\.5/, () => ok({ action: 'jog', y: -1, z: 0.5 }));
	await expectLog(/^Send: G28 X0 Y0$/, () => ok({ action: 'home', axes: ['x', 'y'] }));
	await expectLog(/^Send: M106 S128$/, () => ok({ action: 'fan', speed: 50 }));
	await expectLog(/^Send: M107$/, () => ok({ action: 'fan', speed: 0 }));
	await expectLog(/^Send: M220 S150$/, () => ok({ action: 'feedrate', factor: 150 }));
	await expectLog(/^Send: M221 S90$/, () => ok({ action: 'flowrate', factor: 90 }));
	await expectLog(/^Send: M18$/, () => ok({ action: 'motors_off' }));
	await expectLog(/^Send: T1$/, () => ok({ action: 'tool', tool: 'tool1' }));
	await expectLog(/^Send: G1 E-2(\.0+)? F300/, () => ok({ action: 'extrude', amount: -2, tool: 'tool0' }));
	await expectLog(/^Send: M42 P8 S200$/, () => ok({ action: 'custom', name: 'Set brightness', commands: ['M42 P8 S200'] }));
	assert.equal((await ctl({ action: 'feedrate', factor: 500 })).status, 400, 'out-of-range overrides are refused');
	assert.equal((await ctl({ action: 'jog' })).status, 400);

	log('jogs are audited coalesced');
	for (let i = 0; i < 3; i++) await ok({ action: 'jog', x: 1 });
	await ok({ action: 'jog', y: -1 });
	await ok({ action: 'fan', speed: 100 });
	const audit = (await admin.get('/api/audit?limit=200')).data;
	const jogEntries = audit.filter((e) => e.action === 'printer.jog');
	assert.ok(jogEntries.some((e) => e.detail === '4 jogs: X+1 ×3, Y-1 (net X+3 Y-1)'), JSON.stringify(jogEntries.map((e) => e.detail)));
	assert.ok(jogEntries.length <= 3, `${jogEntries.length} jog entries for 6 jogs`);
	for (const a of ['printer.home', 'printer.fan', 'printer.feedrate', 'printer.flowrate', 'printer.motors_off', 'printer.tool', 'printer.extrude', 'printer.custom_control']) {
		assert.ok(audit.some((e) => e.action === a && e.userEmail === OPERATOR.email), a);
	}

	log('terminal: send, dangerous commands need confirming');
	await expectLog(/^Send: M114$/, async () => assert.equal((await operator.post(`${base}/command`, { commands: 'M114' })).status, 200));
	for (const cmd of ['M500', 'M502', 'm999', 'N5 M112']) {
		const r = await operator.post(`${base}/command`, { commands: [cmd] });
		assert.equal(r.status, 409, cmd);
		assert.equal(r.data.confirmRequired, true, cmd);
	}
	assert.match((await operator.post(`${base}/command`, { commands: ['M500'] })).data.message, /EEPROM/);
	await expectLog(/^Send: M500$/, async () => assert.equal((await operator.post(`${base}/command`, { commands: ['M500'], confirm: true })).status, 200));
	assert.equal((await ctl({ action: 'custom', name: 'x', commands: ['M502'] })).status, 409, 'custom controls follow the same rules');

	log('viewers can read but not act');
	assert.equal((await viewer.post(`${base}/control`, { action: 'jog', x: 1 })).status, 403);
	assert.equal((await viewer.post(`${base}/control`, { action: 'fan', speed: 0 })).status, 403);
	assert.equal((await viewer.post(`${base}/command`, { commands: ['M105'] })).status, 403);

	// --- browser ------------------------------------------------------------------------------------
	browser = await chromium.launch();
	const newPage = async (theme) => {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
		await ctx.addInitScript((t) => localStorage.setItem('ocm-theme', t), theme);
		await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
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

	log('browser: Control tab buttons and keyboard');
	await admin.post(`${base}/temperature`, { targets: { tool0: 215, tool1: 200, bed: 60 } });
	const dark = await newPage('dark');
	await signIn(dark, OPERATOR);
	await dark.goto(`${APP}/p/${p.id}?tab=control`);
	await dark.waitForSelector('text=E2E IDEX');
	await dark.waitForSelector('text=Y inverted');
	await expectLog(/^Send: G0 X10(\.0+)? F6000/, () => dark.click('button[aria-label="X+ (right)"]'), 'X+ button');
	await expectLog(/^Send: G0 Y-10(\.0+)? F6000/, () => dark.click('button[aria-label="Y+ (back)"]'), 'Y+ button on an inverted Y');
	await dark.click('[role=radio]:has-text("0.1")');
	await expectLog(/^Send: G0 Z0?\.1 F200/, () => dark.click('button[aria-label="Z+ (up)"]'), 'Z+ 0.1');
	await expectLog(/^Send: G28 Z0$/, () => dark.click('button[aria-label="Home Z"]'), 'home Z');
	// Keyboard: only while the Move card has focus.
	await dark.click('[data-testid=jog-pad] h2');
	await dark.keyboard.press('3');
	await expectLog(/^Send: G0 X-10(\.0+)? F6000/, () => dark.keyboard.press('ArrowLeft'), 'ArrowLeft');
	await expectLog(/^Send: G0 Z10(\.0+)? F200/, () => dark.keyboard.press('PageUp'), 'PageUp');
	await expectLog(/^Send: G28 X0 Y0$/, () => dark.keyboard.press('Home'), 'Home key');
	await dark.click('button[aria-label="Keyboard shortcuts"]');
	await dark.waitForSelector('[role=dialog][aria-label="Keyboard shortcuts"]');
	await dark.click('button[aria-label="Keyboard shortcuts"]');
	await dark.click('body', { position: { x: 5, y: 5 } });
	const beforeKeys = (await logs()).filter((l) => /^Send: G0 X/.test(l)).length;
	await dark.keyboard.press('ArrowRight');
	await sleep(1200);
	assert.equal((await logs()).filter((l) => /^Send: G0 X/.test(l)).length, beforeKeys, 'arrow keys do nothing without focus');
	await expectLog(/^Send: T1$/, () => dark.click('[role=radio]:has-text("Tool 2")'), 'tool select');
	await expectLog(/^Send: M106 S255$/, () => dark.getByRole('button', { name: 'On', exact: true }).click(), 'fan on');
	await dark.$eval('#r-feedrate', (el) => {
		el.value = '120';
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await expectLog(/^Send: M220 S120$/, () => dark.click('#r-feedrate ~ button:has-text("Set")'), 'feed rate');
	await expectLog(/^Send: M114$/, () => dark.click('[data-testid=custom-controls] button:has-text("Report position")'), 'custom control');
	await dark.waitForSelector('[data-testid=custom-controls] >> text=/X -?[\\d.]+ · Y/');
	await dark.click('[data-testid=jog-pad] h2');
	await dark.mouse.move(0, 0);
	await sleep(4000); // let the toasts fade
	await shot(dark, 'control');

	log('browser: the terminal, a panel under the controls; Expand gives it the tab');
	await dark.goto(`${APP}/p/${p.id}?tab=control`);
	await dark.waitForSelector('[data-testid=terminal-panel] [data-testid=terminal-log] [data-line]');
	await dark.click('[data-testid=terminal-panel] button:has-text("Expand")');
	await dark.waitForURL(/tab=control&view=terminal/);
	await dark.waitForSelector('[data-testid=terminal-expanded] [data-testid=terminal-log] [data-line]');
	assert.equal(await dark.locator('[data-testid=jog-pad]').count(), 0, 'expanded: the terminal has the tab to itself');
	const input = dark.locator('[data-testid=terminal-input]');
	await input.click();
	await input.type('m10');
	await dark.waitForSelector('[data-testid=gcode-suggestions] >> text=Report temperatures');
	await dark.keyboard.press('ArrowDown');
	await dark.keyboard.press('ArrowDown');
	await dark.keyboard.press('Tab');
	assert.equal(await input.inputValue(), 'M105 ', 'Tab completes the chosen code');
	await input.fill('');
	await input.type('g28 x');
	await dark.keyboard.press('Shift+Enter');
	await input.type('m114');
	await expectLog(/^Send: M114$/, () => dark.keyboard.press('Enter'), 'multi-line send');
	assert.ok((await logs()).includes('Send: G28 X'), 'uppercased before sending');
	assert.equal(await input.inputValue(), '', 'the prompt clears after sending');
	// Filters: hide bare "ok" lines.
	const okLines = () => dark.$$eval('[data-testid=terminal-log] [data-line]', (els) => els.filter((e) => /^Recv\s*ok$/i.test(e.textContent.trim().replace(/\s+/g, ' '))).length);
	await waitFor(async () => (await okLines()) > 0, 'ok lines in view');
	await dark.click('[data-filter=ok]');
	assert.equal(await okLines(), 0, 'the ok filter hides them');
	const temps = () => dark.$$eval('[data-testid=terminal-log] [data-line]', (els) => els.filter((e) => /T:\s*\d/.test(e.textContent)).length);
	assert.equal(await temps(), 0, 'temperature reports are hidden by default');
	await dark.click('[data-filter=temperature]');
	await waitFor(async () => (await temps()) > 0, 'temperature lines once shown');
	await dark.click('[data-filter=temperature]');
	// Search narrows and highlights.
	await dark.fill('input[aria-label="Search the log"]', 'M114');
	await waitFor(async () => (await dark.$$eval('[data-testid=terminal-log] [data-line]', (els) => els.every((e) => /m114/i.test(e.textContent)) && els.length > 0)), 'search results');
	assert.ok((await dark.locator('[data-testid=terminal-log] mark').count()) > 0, 'matches are highlighted');
	await dark.click('button[aria-label="Clear search"]');
	// History survives a reload.
	await dark.reload();
	await dark.waitForSelector('[data-testid=terminal-log] [data-line]');
	await input.click();
	await dark.keyboard.press('ArrowUp');
	assert.equal(await input.inputValue(), 'G28 X\nM114', 'the last command comes back with ↑');
	await input.fill('');
	// A dangerous command asks first.
	await input.type('M502');
	await dark.keyboard.press('Enter');
	await dark.waitForSelector('dialog[open] >> text=factory defaults');
	await dark.click('dialog[open] button:has-text("Cancel")');
	await input.fill('');
	// Scrolling up pauses following.
	await dark.$eval('[data-testid=terminal-log]', (el) => (el.scrollTop = 0));
	await dark.waitForSelector('[data-testid=resume-follow]');
	await dark.click('[data-testid=resume-follow]');
	await dark.waitForSelector('[data-testid=resume-follow]', { state: 'detached' });
	await dark.click('button:has-text("Copy")');
	assert.ok((await dark.evaluate(() => navigator.clipboard.readText())).includes('Send: M114'), 'copy puts the lines on the clipboard');
	await input.click();
	await input.type('M1');
	await dark.waitForSelector('[data-testid=gcode-suggestions]');
	await sleep(500);
	await shot(dark, 'terminal');
	await input.fill('');

	log('browser: light theme');
	const light = await newPage('light');
	await signIn(light, ADMIN);
	await light.goto(`${APP}/p/${p.id}?tab=control`);
	await light.waitForSelector('text=E2E IDEX');
	await sleep(1500);
	await shot(light, 'control-light');
	// The old Terminal tab's link opens the expanded terminal.
	await light.goto(`${APP}/p/${p.id}?tab=terminal`);
	await light.waitForURL(/tab=control&view=terminal/);
	await light.waitForSelector('[data-testid=terminal-log] [data-line]');
	await light.fill('input[aria-label="Search the log"]', 'G0');
	await sleep(800);
	await shot(light, 'terminal-light');

	log('browser: viewers see disabled controls and no prompt');
	const view = await newPage('dark');
	await signIn(view, VIEWER);
	await view.goto(`${APP}/p/${p.id}?tab=control`);
	await view.waitForSelector('[data-testid=viewer-hint]');
	assert.ok(await view.locator('button[aria-label="X+ (right)"]').isDisabled());
	assert.ok(await view.locator('button:has-text("Home all")').isDisabled());
	await view.goto(`${APP}/p/${p.id}?tab=control&view=terminal`);
	await view.waitForSelector('[data-testid=terminal-expanded] [data-testid=viewer-hint]');
	assert.equal(await view.locator('[data-testid=terminal-input]').count(), 0);
	assert.equal(await view.locator('button:has-text("Emergency stop")').count(), 0);

	log('while printing: movement refused, overrides allowed, G-code confirmed');
	const fd = new FormData();
	fd.set('file', new Blob([slowGcode()]), 'e2e-slow.gcode');
	fd.set('print', 'true');
	assert.equal((await fetch(`${OP.url}/api/files/local`, { method: 'POST', headers: { 'X-Api-Key': OP.key }, body: fd })).status, 201);
	await waitFor(async () => (await opState()).startsWith('Printing'), 'printing');
	const blocked = await ctl({ action: 'jog', x: 10 });
	assert.equal(blocked.status, 409);
	assert.equal(blocked.data.blocked, true);
	assert.match(blocked.data.message, /print is running/);
	assert.equal((await ctl({ action: 'home', axes: ['x'] })).status, 409);
	assert.equal((await ctl({ action: 'extrude', amount: 5 })).status, 409);
	await ok({ action: 'feedrate', factor: 110 });
	await ok({ action: 'fan', speed: 80 });
	assert.equal((await ctl({ action: 'custom', name: 'x', commands: ['M114'] })).status, 409, 'custom G-code while printing needs confirming');
	await dark.goto(`${APP}/p/${p.id}?tab=control`);
	await dark.waitForSelector('[data-testid=movement-blocked]');
	assert.ok(await dark.locator('button[aria-label="X+ (right)"]').isDisabled());
	assert.ok(!(await dark.getByRole('button', { name: 'On', exact: true }).isDisabled()), 'the fan still works while printing');
	await sleep(800);
	await shot(dark, 'control-printing');
	assert.equal((await operator.post(`${base}/job`, { command: 'cancel', confirm: true })).status, 200);

	for (const pg of [dark, light, view]) assert.deepEqual(pg.errors, [], 'no browser errors');
	sse.abort();
	log('all control/terminal e2e checks passed');
	if (process.env.E2E_APPLOG) console.log(appLog);
}

/** A session cookie for the SSE request (fetch can't reuse the client's). */
async function loginCookie(who) {
	const res = await fetch(`${APP}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: APP }, body: JSON.stringify(who) });
	return res.headers.get('set-cookie').split(';')[0];
}

async function cleanup() {
	await browser?.close().catch(() => {});
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
