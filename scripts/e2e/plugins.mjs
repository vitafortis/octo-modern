// End-to-end test of Care › Plugins & updates, against local mocks only: a mock OctoPrint with the
// Plugin Manager, Software Update and a restart command (push socket on), and one whose key isn't an
// OctoPrint admin's. Nothing is downloaded; no real printer or service is contacted.
//
//   pnpm e2e:plugins                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:plugins        # leave the app and mocks running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:plugins  # reuse ./build
//
// Ports 4500–4502 (E2E_PORT_BASE moves them): app +0, OctoPrint +1 (admin key) and +2 (user key).
// Needs a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMockOctoPrint } from './mock-octoprint.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const PORT_BASE = Number(process.env.E2E_PORT_BASE ?? 4500);
const APP_PORT = PORT_BASE;
const APP = `http://127.0.0.1:${APP_PORT}`;
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

let app;
let browser;
const closers = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-plugins-'));

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
	return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) };
}

// --- demo data: a typical OctoPi -------------------------------------------------------------------

const GINA = 'Gina Häußge';
const PLUGINS = [
	{ key: 'achievements', name: 'Achievements', bundled: true, author: 'Charlie Powell', description: 'Achievements for OctoPrint' },
	{ key: 'announcements', name: 'Announcement Plugin', bundled: true, author: GINA, description: 'Announcements all around OctoPrint' },
	{ key: 'appkeys', name: 'Application Keys Plugin', bundled: true, author: GINA, description: 'Implements a workflow for third party clients to obtain API keys' },
	{ key: 'backup', name: 'Backup & Restore', bundled: true, author: GINA, description: 'Backup & restore your OctoPrint settings and data' },
	{ key: 'classicwebcam', name: 'Classic Webcam', bundled: true, author: 'Christian Würthner', description: 'Provides a simple webcam viewer in OctoPrint’s UI, images provided by an MJPEG webcam.' },
	{ key: 'errortracking', name: 'Error Tracking', bundled: true, enabled: false, author: GINA, description: 'Sentry integration for automatic error tracking' },
	{ key: 'eventmanager', name: 'Event Manager', bundled: true, author: 'Shawn Bruce', description: 'Allows configuring event subscriptions through settings' },
	{ key: 'file_check', name: 'File Check', bundled: true, managable: true, version: '2025.7.23', author: GINA, description: 'Checks for common issues in uploaded files' },
	{ key: 'firmware_check', name: 'Firmware Check', bundled: true, managable: true, version: '2025.7.23', author: GINA, description: 'Checks for unsafe or broken printer firmwares' },
	{ key: 'gcodeviewer', name: 'GCode Viewer', bundled: true, author: GINA, description: 'Provides a GCODE viewer in OctoPrint’s UI.', disabling_discouraged: 'Without this plugin the GCode Viewer in OctoPrint will no longer be available.' },
	{ key: 'logging', name: 'Logging', bundled: true, author: GINA, description: 'Provides access to OctoPrint’s logs and logging configuration.' },
	{ key: 'softwareupdate', name: 'Software Update', bundled: true, author: GINA, description: 'Allows receiving update notifications and performing updates of OctoPrint and plugins' },
	{ key: 'virtual_printer', name: 'Virtual Printer', bundled: true, enabled: false, author: GINA, description: 'Provides a virtual printer via a virtual serial port for development and testing purposes' },
	{ key: 'bedlevelvisualizer', name: 'Bed Visualizer', version: '1.1.1', author: 'jneilliii', description: 'Displays 3D mesh of bed topography report.', url: 'https://github.com/jneilliii/OctoPrint-BedLevelVisualizer' },
	{ key: 'octolapse', name: 'Octolapse', version: '0.4.4', author: 'Brad Hochgesang', description: 'Create stabilized timelapses of your 3d prints. Highly customizable, loads of presets, lots of fun.', url: 'https://github.com/FormerLurker/Octolapse' },
	{ key: 'PrintTimeGenius', name: 'Print Time Genius', version: '2.3.3', author: 'Eyal Soha', description: 'Use a gcode pre-analysis to provide better print time estimation' },
	{ key: 'DisplayLayerProgress', name: 'DisplayLayerProgress', version: '1.28.0', author: 'Olli', description: 'Shows layer progress, height and estimated time in the navbar and the printer display.' },
	{ key: 'dashboard', name: 'OctoPrint-Dashboard', version: '1.19.2', author: 'Will MacCormack, Stefan Cohen', description: 'A dashboard tab for OctoPrint' },
	{ key: 'psucontrol', name: 'PSU Control', version: '1.0.6', author: 'Shawn Bruce', description: 'Control the printer’s power supply through GPIO or system commands.' },
	{ key: 'themeify', name: 'Themeify', version: '1.2.2', enabled: false, author: 'Birk Johansson', description: 'Beautiful themes for OctoPrint' },
	{ key: 'firmwareupdater', name: 'Firmware Updater', version: '1.14.0', author: 'Gina Häußge, Ben Lye, Nicanor Romero Venier', description: 'Flash firmware to your printer from OctoPrint' }
];
const REPO = [
	['obico', 'Obico for OctoPrint', 'The Obico team', 'AI failure detection, remote monitoring and control, mobile app', 42000, 230],
	['octoeverywhere', 'OctoEverywhere', 'Quinn Damerell', 'Free and secure remote access, AI failure detection, notifications and more', 38000, 310],
	['bedlevelvisualizer', 'Bed Visualizer', 'jneilliii', 'Displays 3D mesh of bed topography report.', 61000, 560],
	['octolapse', 'Octolapse', 'Brad Hochgesang', 'Create stabilized timelapses of your 3d prints.', 48000, 690],
	['PrintTimeGenius', 'Print Time Genius', 'Eyal Soha', 'Use a gcode pre-analysis to provide better print time estimation', 33000, 290],
	['DisplayLayerProgress', 'DisplayLayerProgress', 'Olli', 'Shows layer progress and estimated time in the navbar and on the printer display', 41000, 380],
	['themeify', 'Themeify', 'Birk Johansson', 'Beautiful themes for OctoPrint', 29000, 400],
	['psucontrol', 'PSU Control', 'Shawn Bruce', 'Control the printer’s power supply through GPIO or system commands', 26000, 310],
	['bedlevelingwizard', 'Bed Leveling Wizard', 'Bryan Robinson', 'A wizard that walks you around the bed for manual leveling, corner by corner', 2100, 40],
	['arc_welder', 'Arc Welder: Anti-Stutter', 'Brad Hochgesang', 'Converts G0/G1 commands to G2/G3 arcs to reduce stuttering', 18000, 480],
	['cancelobject', 'Cancel Objects', 'Paul Paukstelis', 'Cancel single objects during a print', 15000, 190],
	['excluderegion', 'Exclude Region', 'Bradford Sturtevant', 'Prevent printing in a region of the bed (e.g. a damaged spot)', 6000, 110],
	['firmwareupdater', 'Firmware Updater', 'Gina Häußge, Ben Lye', 'Flash firmware to your printer from OctoPrint', 31000, 330],
	['dashboard', 'OctoPrint-Dashboard', 'Will MacCormack', 'A dashboard tab for OctoPrint', 24000, 390],
	['telegram', 'Telegram Notifications', 'Fabian Schlenz', 'Notifications and control of your printer through Telegram', 14000, 500],
	['navbartemp', 'Navbar Temperature', 'Jarek Szczepanski', 'Temperatures in the navbar, plus the Pi’s SoC temperature', 22000, 120],
	['resource_monitor', 'Resource Monitor', 'Renaud Gaspard', 'CPU, memory, disk and network usage of the OctoPrint host', 9000, 110],
	['SpoolManager', 'SpoolManager', 'Olli', 'Track your filament spools and their usage', 12000, 280],
	['heaterbedtimer', 'Bed Heater Timer', 'Old Author', 'Turns the bed off after a while (Python 2 only)', 300, 4, { compatible: false, attributes: ['abandoned'] }]
].map(([id, title, author, description, installs, stars, extra]) => ({ id, title, author, description, installs, stars, ...(extra ?? {}) }));
const UPDATES = {
	octoprint: { available: '1.11.3', releaseNotes: 'https://github.com/OctoPrint/OctoPrint/releases/tag/1.11.3' },
	octolapse: { available: '0.4.5', releaseNotes: 'https://github.com/FormerLurker/Octolapse/releases/tag/v0.4.5' },
	PrintTimeGenius: { available: '2.4.0', releaseNotes: 'https://github.com/eyal0/OctoPrint-PrintTimeGenius/releases/tag/2.4.0' }
};

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting mock OctoPrint servers');
	const mk4Op = await startMockOctoPrint({
		port: PORT_BASE + 1,
		apiKey: 'mk4-plugins-key',
		push: true,
		connectMs: 300,
		printSeconds: 600,
		pluginManager: { plugins: PLUGINS, repository: REPO, updates: UPDATES, restartNeeding: ['themeify', 'octolapse'], installMs: 2500, updateMs: 3000, restartMs: 3000 }
	});
	const enderOp = await startMockOctoPrint({ port: PORT_BASE + 2, apiKey: 'ender-user-key', connectMs: 300, pluginManager: { plugins: PLUGINS, forbidden: true } });
	closers.push(mk4Op.close, enderOp.close);
	for (const [op, key] of [
		[mk4Op, 'mk4-plugins-key'],
		[enderOp, 'ender-user-key']
	]) {
		await fetch(`${op.url}/api/connection`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ command: 'connect' }) });
	}

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
	const mk4 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: mk4Op.url, apiKey: 'mk4-plugins-key', color: 'violet' })).data;
	const ender = (await admin.post('/api/printers', { name: 'Ender 3', baseUrl: enderOp.url, apiKey: 'ender-user-key', color: 'amber' })).data;
	for (const u of [
		{ ...OPERATOR, role: 'operator' },
		{ ...VIEWER, role: 'viewer' }
	]) assert.equal((await admin.post('/api/users', u)).status, 201);
	const operator = client();
	const viewer = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);
	const stateOf = async (id) => (await admin.get('/api/printers/status')).data.find((s) => s.id === id)?.state;
	const audits = async (action) => (await admin.get(`/api/audit?action=${action}`)).data;
	await waitFor(async () => (await stateOf(mk4.id)) === 'operational', 'MK4 ready');
	const base = `/api/printers/${mk4.id}/plugins`;

	// --- API: roles, a non-admin key, confirmations, refusals --------------------------------------------
	log('API: admins only; a user key shows the not-an-admin state');
	for (const c of [operator, viewer]) {
		assert.equal((await c.get(base)).status, 403);
		assert.equal((await c.post(base, { action: 'restart', confirm: true })).status, 403);
		assert.equal((await c.get(`${base}/updates?force=1`)).status, 403);
	}
	let r = await admin.get(base);
	assert.equal(r.status, 200, r.text);
	assert.equal(r.data.access, 'ok');
	assert.equal(r.data.plugins.length, PLUGINS.length);
	assert.equal(r.data.restartCommand, true);
	assert.equal(r.data.restartNeeded, false);
	r = await admin.get(`/api/printers/${ender.id}/plugins`);
	assert.equal(r.status, 200);
	assert.equal(r.data.access, 'forbidden');
	assert.match(r.data.message, /isn’t an OctoPrint admin/);

	log('API: drastic actions ask first; nothing reaches OctoPrint before');
	r = await admin.post(base, { action: 'uninstall', plugin: 'dashboard' });
	assert.equal(r.status, 409);
	assert.equal(r.data.confirmRequired, true);
	assert.match(r.data.title, /Uninstall OctoPrint-Dashboard/);
	r = await admin.post(base, { action: 'install', url: 'https://example.com/OctoPrint-Thing/archive/main.zip' });
	assert.equal(r.data.confirmRequired, true);
	assert.match(r.data.message, /full rights/);
	assert.equal((await admin.post(base, { action: 'install', url: 'file:///etc/passwd', confirm: true })).status, 400);
	r = await admin.post(base, { action: 'update', targets: 'all' });
	assert.equal(r.data.confirmRequired, true);
	assert.match(r.data.message, /OctoPrint 1\.11\.2 → 1\.11\.3/);
	r = await admin.post(base, { action: 'restart' });
	assert.equal(r.data.confirmRequired, true);
	assert.equal((await admin.post(base, { action: 'uninstall', plugin: 'logging', confirm: true })).status, 400, 'bundled');
	assert.equal((await admin.post(base, { action: 'install', plugin: 'heaterbedtimer' })).status, 400, 'incompatible');
	assert.deepEqual(mk4Op.pluginManager.calls, []);

	log('API: refused while printing');
	await fetch(`${mk4Op.url}/__mock/print?file=bracket.gcode`);
	await waitFor(async () => (await stateOf(mk4.id)) === 'printing', 'MK4 printing');
	for (const body of [{ action: 'install', plugin: 'obico' }, { action: 'update', targets: 'all', confirm: true }, { action: 'restart', confirm: true }, { action: 'uninstall', plugin: 'dashboard', confirm: true }]) {
		r = await admin.post(base, body);
		assert.equal(r.status, 409, `${body.action}: ${r.text}`);
		assert.ok(!r.data.confirmRequired, 'refused, not confirmable');
		assert.match(r.data.message, /is printing/);
	}
	assert.equal((await admin.get(base)).data.printing, true);
	assert.equal((await operator.post(`/api/printers/${mk4.id}/job`, { command: 'cancel', confirm: true })).status, 200);
	await waitFor(async () => (await stateOf(mk4.id)) === 'operational', 'MK4 idle again');
	assert.deepEqual(mk4Op.pluginManager.calls, []);
	// The update check, as the background job does it: the Care badge.
	assert.equal((await admin.get(`${base}/updates`)).data.status, 'updatePossible');

	// --- browser -----------------------------------------------------------------------------------------------
	browser = await chromium.launch();
	const newPage = async (theme, width = 1440, height = 1000) => {
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
	const shot = async (page, name, opts = {}) => {
		await page.screenshot({ path: join(SHOTS, `${name}.png`), ...opts });
		log(`  screenshot ${name}.png`);
	};
	const openPlugins = async (page, id = mk4.id) => {
		await page.goto(`${APP}/p/${id}?tab=care&view=plugins`);
		await page.waitForSelector('[data-testid=plugins-tab]');
	};
	const pane = async (page, label) => {
		await page.click(`[data-testid=plugins-tab] [data-testid=segmented] button:has-text("${label}")`);
	};

	log('browser: operators get no Plugins & updates view');
	const opPage = await newPage('dark');
	await signIn(opPage, OPERATOR);
	await opPage.goto(`${APP}/p/${mk4.id}?tab=care`);
	await opPage.waitForSelector('nav[aria-label="Printer sections"] [aria-current=page]:has-text("Care")');
	await sleep(400);
	assert.equal(await opPage.locator('[data-testid=segmented] :text("Plugins & updates")').count(), 0);
	assert.equal(await opPage.locator('[data-testid=care-updates-dot]').count(), 0);

	log('browser (light): installed, Get more, Updates');
	const light = await newPage('light');
	await signIn(light, ADMIN);
	await light.goto(`${APP}/p/${mk4.id}?tab=care`);
	await light.waitForSelector('[data-testid=care-updates-dot]');
	await light.click('[data-testid=segmented] button:has-text("Plugins & updates")');
	await light.waitForURL(/tab=care&view=plugins/);
	await light.waitForSelector('[data-testid=plugins-installed] [data-plugin=octolapse]');
	await light.waitForSelector('[data-testid=octoprint-available]:has-text("1.11.3")');
	await sleep(500);
	await shot(light, 'plugins-light');
	await pane(light, 'Get more');
	await light.waitForSelector('[data-testid=plugins-repository] [data-repo]');
	await light.fill('[data-testid=repo-search]', 'bed');
	await light.waitForSelector('[data-repo=bedlevelingwizard]');
	await sleep(400);
	await shot(light, 'plugins-install-light');
	await pane(light, 'Updates');
	await light.waitForSelector('[data-testid=plugins-updates] [data-target=octolapse]');
	await sleep(400);
	await shot(light, 'plugins-updates-light');

	log('browser (dark): installed list, search, the not-an-admin state');
	const dark = await newPage('dark');
	await signIn(dark, ADMIN);
	await openPlugins(dark);
	await dark.waitForSelector('[data-testid=plugins-installed] [data-plugin=octolapse]');
	await dark.waitForSelector('[data-testid=octoprint-available]:has-text("1.11.3")');
	assert.equal(await dark.locator('[data-plugin=logging] [data-testid=uninstall]').count(), 0, 'bundled: no uninstall');
	assert.equal(await dark.locator('[data-plugin=octolapse] [data-testid=uninstall]').count(), 1);
	await sleep(500);
	await shot(dark, 'plugins');
	await dark.fill('[data-testid=plugins-search]', 'layer');
	await dark.waitForFunction(() => document.querySelectorAll('[data-testid=plugins-installed] [data-plugin]').length === 1);
	await dark.fill('[data-testid=plugins-search]', '');
	await dark.selectOption('[data-testid=plugins-filter]', 'disabled');
	await dark.waitForFunction(() => document.querySelectorAll('[data-testid=plugins-installed] [data-plugin]').length === 3);
	await dark.selectOption('[data-testid=plugins-filter]', 'all');

	const forbidden = await newPage('dark');
	await signIn(forbidden, ADMIN);
	await openPlugins(forbidden, ender.id);
	await forbidden.waitForSelector('[data-testid=plugins-forbidden]:has-text("isn’t an OctoPrint admin")');

	log('browser: Updates view, phone');
	await pane(dark, 'Updates');
	await dark.waitForSelector('[data-testid=plugins-updates] [data-target=octolapse]');
	await sleep(400);
	await shot(dark, 'plugins-updates');
	await pane(dark, 'Get more');
	await dark.waitForSelector('[data-repo=obico]');
	await dark.fill('[data-testid=repo-search]', 'bed');
	await dark.waitForSelector('[data-repo=bedlevelingwizard]');
	await sleep(400);
	await shot(dark, 'plugins-install');
	await pane(dark, 'Installed');

	const phone = await newPage('dark', 390, 844);
	await signIn(phone, ADMIN);
	await openPlugins(phone);
	await phone.waitForSelector('[data-testid=plugins-installed] [data-plugin=octolapse]');
	assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
	for (const sel of ['[data-testid=octoprint-version]', '[data-testid=plugins-installed]', '[data-testid=restart-octoprint]']) {
		const box = await phone.locator(sel).boundingBox();
		assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${sel} fits the phone (${JSON.stringify(box)})`);
	}
	const sw = await phone.locator('[data-plugin=octolapse] [role=switch]').boundingBox();
	assert.ok(sw && sw.x + sw.width <= 390, 'switch on screen');
	await sleep(500);
	await shot(phone, 'mobile-plugins');

	log('browser: enable/disable; a restart-needing change shows the banner');
	await dark.click('[data-plugin=PrintTimeGenius] [role=switch]');
	await dark.waitForSelector('text=Print Time Genius disabled');
	assert.equal(await dark.locator('[data-testid=restart-banner]').count(), 0, 'no restart needed for this one');
	assert.equal(await dark.getAttribute('[data-plugin=PrintTimeGenius] [role=switch]', 'aria-checked'), 'false');
	await dark.click('[data-plugin=themeify] [role=switch]');
	await dark.waitForSelector('[data-testid=restart-banner]');
	await dark.waitForSelector('[data-plugin=themeify] :text("enabled · restart")');
	assert.ok((await audits('plugins.enable')).some((e) => /Themeify/.test(e.detail) && /restart needed/.test(e.detail)));
	assert.ok((await audits('plugins.disable')).some((e) => /Print Time Genius/.test(e.detail)));

	log('browser: install from the repository, with the live log');
	await pane(dark, 'Get more');
	await dark.fill('[data-testid=repo-search]', 'bed');
	await dark.waitForSelector('[data-repo=bedlevelingwizard]');
	assert.equal(await dark.locator('[data-repo=bedlevelvisualizer] [data-testid=install]').count(), 0, 'installed already');
	assert.ok(await dark.locator('[data-repo=heaterbedtimer] [data-testid=install]').isDisabled(), 'incompatible');
	await dark.click('[data-repo=bedlevelingwizard] [data-testid=install]');
	await dark.waitForSelector('[data-testid=plugin-op][data-phase=running]');
	await dark.waitForSelector('[data-testid=plugin-op-log] :text("pip install")');
	await dark.waitForSelector('[data-testid=plugin-op][data-phase=done]', { timeout: 20_000 });
	await dark.waitForSelector('text=Bed Leveling Wizard 1.0.0 installed');
	assert.ok((await audits('plugins.install')).some((e) => /bedlevelingwizard/.test(e.detail)));

	log('browser: install from a URL asks first (plugins run code on the Pi)');
	await dark.fill('[data-testid=install-url-input]', 'https://example.com/OctoPrint-Fail/archive/main.zip');
	await dark.click('[data-testid=install-url] button:has-text("Install")');
	await dark.waitForSelector('dialog[open] >> text=Install a plugin from a URL?');
	await dark.click('dialog[open] button:has-text("Install")');
	await dark.waitForSelector('[data-testid=plugin-op][data-phase=error]', { timeout: 20_000 });
	await dark.waitForSelector('[data-testid=plugin-op-log] .text-danger');

	log('browser: uninstall with "delete settings and data"');
	await pane(dark, 'Installed');
	await dark.click('[data-plugin=dashboard] [data-testid=uninstall]');
	await dark.waitForSelector('dialog[open] >> text=Uninstall OctoPrint-Dashboard?');
	await dark.click('dialog[open] input[type=checkbox]');
	await dark.click('dialog[open] button:has-text("Uninstall")');
	await dark.waitForSelector('[data-plugin=dashboard] :text("uninstalled · restart")');
	assert.deepEqual(mk4Op.pluginManager.calls.find((c) => c.command === 'uninstall'), { command: 'uninstall', plugin: 'dashboard', cleanup: true });
	assert.ok((await audits('plugins.uninstall')).some((e) => /with its settings and data/.test(e.detail)));

	log('browser: Update all → OctoPrint restarts → back on 1.11.3');
	await pane(dark, 'Updates');
	await dark.waitForSelector('[data-testid=plugins-updates] [data-target=octolapse]');
	await dark.click('[data-testid=plugin-op-hide]');
	await dark.click('[data-testid=update-all]');
	await dark.waitForSelector('dialog[open] >> text=Update 3 targets on Prusa MK4?');
	await dark.click('dialog[open] button:has-text("Update all")');
	await dark.waitForSelector('[data-testid=plugin-op][data-phase=running]');
	await dark.waitForSelector('[data-testid=plugin-op-log] :text("Updating OctoPrint to 1.11.3")', { timeout: 15_000 });
	await dark.waitForSelector('[data-testid=plugin-op][data-phase=restarting]', { timeout: 15_000 });
	for (const b of await dark.locator('[aria-label=Dismiss]').all()) await b.click({ timeout: 300 }).catch(() => {});
	await dark.evaluate(() => document.querySelector('[data-testid=plugins-tab]')?.closest('.overflow-y-auto')?.scrollTo(0, 0));
	await sleep(300);
	await shot(dark, 'plugins-updating');
	await dark.waitForSelector('[data-testid=plugin-op][data-phase=done]', { timeout: 30_000 });
	await dark.waitForSelector('[data-testid=octoprint-current]:has-text("1.11.3")', { timeout: 15_000 });
	assert.equal(await dark.locator('[data-testid=octoprint-available]').count(), 0);
	assert.equal(mk4Op.state.version, '1.11.3');
	assert.equal(await dark.locator('[data-testid=restart-banner]').count(), 0, 'the restart applied the pending changes');
	assert.ok((await audits('octoprint.update')).some((e) => /OctoPrint 1\.11\.2 → 1\.11\.3/.test(e.detail)));
	r = await admin.get(base);
	assert.equal(r.data.octoprint, '1.11.3');
	assert.equal(r.data.updates.available.length, 0);
	assert.ok(!r.data.plugins.some((p) => p.key === 'dashboard'), 'uninstalled for good after the restart');

	log('browser: Restart OctoPrint');
	await dark.click('[data-testid=restart-octoprint]');
	await dark.waitForSelector('dialog[open] >> text=Restart OctoPrint on Prusa MK4?');
	await dark.click('dialog[open] button:has-text("Restart")');
	await dark.waitForSelector('[data-testid=plugin-op][data-phase=restarting]');
	await dark.waitForSelector('[data-testid=plugin-op][data-phase=done]', { timeout: 30_000 });
	assert.equal(mk4Op.pluginManager.restarts, 2);
	assert.ok((await audits('octoprint.restart')).length === 1);

	for (const p of [opPage, light, dark, forbidden, phone]) assert.deepEqual(p.errors, [], 'no browser errors');
	log('all plugins e2e checks passed');
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
