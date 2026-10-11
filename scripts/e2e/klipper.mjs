// End-to-end test of Klipper support against a mock Moonraker (HTTP + JSON-RPC websocket).
// No Docker, no real printer: scripts/e2e/mock-moonraker.mjs simulates Klipper.
//
//   pnpm e2e:klipper                  # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:klipper       # leave the app and the mock running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:klipper # reuse ./build
//
// Ports (5560–5569 by default, E2E_PORT_BASE to move them): app, Moonraker, a keyed Moonraker,
// the webcam, and the mDNS responder (udp).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMockMoonraker } from './mock-moonraker.mjs';
import { startMdnsResponder } from './mock-discovery.mjs';
import { startMjpegSource } from '../mjpeg-source.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const BASE = Number(process.env.E2E_PORT_BASE ?? 5560);
const PORTS = { app: BASE, moonraker: BASE + 1, keyed: BASE + 2, cam: BASE + 3, mdns: BASE + 4 };
const APP = `http://127.0.0.1:${PORTS.app}`;
const KEY = 'e2e-moonraker-key-0123456789abcdef';
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

let app;
let browser;
const mocks = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-klipper-'));

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
	return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), get cookie() { return cookie; } };
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	const cam = await startMjpegSource({ port: PORTS.cam, host: '127.0.0.1' });
	mocks.push(cam);
	const camUrl = `http://127.0.0.1:${PORTS.cam}`;
	const mr = await startMockMoonraker({ port: PORTS.moonraker, printSeconds: 240, webcam: { stream: `${camUrl}/?action=stream`, snapshot: `${camUrl}/?action=snapshot` } });
	const keyed = await startMockMoonraker({ port: PORTS.keyed, apiKey: KEY });
	mocks.push(mr, keyed);
	mocks.push(await startMdnsResponder({ port: PORTS.mdns, service: '_moonraker._tcp.local', instance: 'Moonraker Instance on voron', target: 'voron.local', ip: '127.0.0.1', servicePort: PORTS.moonraker, txt: {} }));
	log(`mock Moonraker on ${mr.url} (keyed: ${keyed.url}), webcam on :${PORTS.cam}, mDNS on udp :${PORTS.mdns}`);

	if (!process.env.E2E_SKIP_BUILD) {
		log('building');
		execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'ignore' });
	}
	log(`starting octo·modern on ${APP}`);
	app = spawn('node', ['build'], {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, PORT: String(PORTS.app), HOST: '127.0.0.1', OCM_DATA_DIR: dataDir, OCM_POLL_INTERVAL_MS: '3000', OCM_MDNS_TARGET: `127.0.0.1:${PORTS.mdns}`, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' }
	});
	let appLog = '';
	app.stdout.on('data', (d) => (appLog += d));
	app.stderr.on('data', (d) => (appLog += d));
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');

	const admin = client();
	assert.equal((await admin.post('/api/auth/setup', ADMIN)).status, 200);
	assert.equal((await admin.post('/api/users', { ...OPERATOR, role: 'operator' })).status, 201);
	const operator = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);

	// --- API: detection, test, add --------------------------------------------------------------
	log('test connection: auto-detects Moonraker; a keyed Moonraker needs its key');
	const t = (await admin.post('/api/printers/test', { baseUrl: mr.url, kind: 'auto' })).data;
	assert.equal(t.ok, true, JSON.stringify(t));
	assert.equal(t.kind, 'moonraker');
	assert.match(t.version, /^Klipper v0\.12\.0 · Moonraker v0\.9\.3$/);
	const noKey = (await admin.post('/api/printers/test', { baseUrl: keyed.url, kind: 'moonraker' })).data;
	assert.equal(noKey.ok, false);
	assert.match(noKey.error.hint, /trusted_clients/);
	assert.equal((await admin.post('/api/printers/test', { baseUrl: keyed.url, apiKey: KEY, kind: 'auto' })).data.ok, true);

	log('mDNS discovery finds _moonraker._tcp');
	const scan = (await admin.post('/api/discover/mdns')).data;
	const found = scan.candidates.find((c) => c.fingerprint.kind === 'moonraker');
	assert.ok(found, JSON.stringify(scan));
	assert.equal(found.name, 'voron');
	assert.equal(found.baseUrl, mr.url);


	// --- browser ---------------------------------------------------------------------------------
	browser = await chromium.launch();
	const newPage = async (theme, viewport = { width: 1440, height: 900 }) => {
		const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme });
		await ctx.addInitScript((th) => localStorage.setItem('ocm-theme', th), theme);
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

	log('browser: add a printer with the type picker (auto-detect), test, save');
	const dark = await newPage('dark');
	await signIn(dark, ADMIN);
	await dark.goto(`${APP}/`);
	await dark.getByRole('button', { name: 'Add printer' }).first().click();
	const picker = dark.getByTestId('kind-picker');
	await picker.waitFor();
	assert.equal(await picker.getByRole('radio', { name: /Auto-detect/ }).getAttribute('aria-checked'), 'true', 'auto-detect by default');
	await dark.fill('#p-name', 'Voron 2.4');
	await dark.fill('#p-url', mr.url);
	await dark.getByRole('button', { name: 'Test connection' }).click();
	await dark.getByText('Klipper v0.12.0 · Moonraker v0.9.3').waitFor();
	await dark.getByText(/Found Klipper/).waitFor();
	await dark.locator('button[aria-label="cyan"]').click();
	await dark.getByText('Klipper v0.12.0 · Moonraker v0.9.3').scrollIntoViewIfNeeded();
	await sleep(300);
	await shot(dark, 'add-printer-klipper');
	const light = await newPage('light');
	await signIn(light, ADMIN);
	await light.goto(`${APP}/`);
	await light.getByRole('button', { name: 'Add printer' }).first().click();
	await light.getByTestId('kind-picker').getByRole('radio', { name: /Klipper/ }).click();
	await light.fill('#p-name', 'Voron 2.4');
	await light.fill('#p-url', mr.url);
	await light.getByText('optional').first().waitFor();
	await sleep(300);
	await shot(light, 'add-printer-klipper-light');
	await light.keyboard.press('Escape');

	await dark.getByRole('button', { name: 'Add printer' }).last().click();
	await dark.waitForURL(/\/p\//);
	const id = dark.url().split('/p/')[1].split('?')[0];
	const base = `/api/printers/${id}`;
	const printer = (await admin.get(base)).data;
	assert.equal(printer.kind, 'moonraker', 'auto-detect saved it as Klipper');
	assert.equal(printer.hasApiKey, false);

	log('live status over the websocket');
	await dark.getByText('Klipper v0.12.0 · Moonraker v0.9.3').first().waitFor();
	await waitFor(async () => (await admin.get('/api/printers/status')).data.find((s) => s.id === id)?.state === 'operational', 'Ready');
	await dark.locator('text=live push').waitFor({ timeout: 15_000 });
	assert.ok(mr.calls.some((c) => c.method === 'printer.objects.subscribe'), 'subscribed over JSON-RPC');
	assert.ok(await dark.getByRole('button', { name: /Timelapse/ }).count() === 0, 'no Timelapse tab for Klipper');
	await dark.getByRole('button', { name: /Files/ }).first().waitFor();

	log('heat up, then print a file from the Files tab');
	assert.equal((await operator.post(`${base}/temperature`, { targets: { tool0: 215, bed: 60 } })).status, 200);
	assert.ok(mr.gcode.includes('SET_HEATER_TEMPERATURE HEATER=extruder TARGET=215\nSET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=60'));
	await dark.goto(`${APP}/p/${id}?tab=files`);
	await dark.getByText('voron_cube_0.2mm_PLA.gcode').waitFor();
	assert.equal(await dark.getByRole('button', { name: 'Load', exact: true }).count(), 0, 'no "load without printing" on Klipper');
	assert.ok((await dark.locator('img[src*="files/thumbnail"]').count()) > 0, 'slicer thumbnails');
	await shot(dark, 'files-klipper');
	await dark.getByTitle('Print benchy.gcode').first().click();
	await waitFor(async () => (await admin.get('/api/printers/status')).data.find((s) => s.id === id)?.state === 'printing', 'printing');
	assert.ok(mr.gcode.includes('SDCARD_PRINT_FILE FILENAME="benchy.gcode"'));
	await sleep(4_000);
	await dark.goto(`${APP}/p/${id}`);
	await dark.getByText('benchy.gcode').first().waitFor();
	await dark.locator('text=live push').waitFor({ timeout: 15_000 });
	await sleep(2_500);
	await shot(dark, 'dashboard-klipper');
	await light.goto(`${APP}/p/${id}`);
	await light.getByText('benchy.gcode').first().waitFor();
	await sleep(2_500);
	await shot(light, 'dashboard-klipper-light');

	log('pause and resume from the page header, then cancel (asks first)');
	await dark.getByRole('button', { name: 'Pause', exact: true }).first().click();
	await waitFor(() => mr.state.status.print_stats.state === 'paused', 'paused');
	await dark.getByRole('button', { name: 'Resume', exact: true }).first().waitFor();
	await dark.getByRole('button', { name: 'Resume', exact: true }).first().click();
	await waitFor(() => mr.state.status.print_stats.state === 'printing', 'resumed');
	await dark.getByRole('button', { name: 'Cancel print' }).first().click();
	await dark.getByRole('dialog').getByRole('button', { name: 'Cancel print' }).click();
	await waitFor(() => mr.state.status.print_stats.state === 'cancelled', 'cancelled');
	assert.ok(['PAUSE', 'RESUME', 'CANCEL_PRINT'].every((g) => mr.gcode.includes(g)), JSON.stringify(mr.gcode));

	log('the print is in the history as cancelled; earlier Klipper jobs were imported');
	const hist = await waitFor(async () => {
		const h = (await admin.get(`/api/history?printer=${id}`)).data;
		const rows = h?.items;
		return Array.isArray(rows) && rows.some((r) => r.file === 'benchy.gcode' && r.result === 'cancelled' && r.source !== 'import') ? rows : null;
	}, 'history entry', { tries: 40 });
	const imp = (await admin.post('/api/history/import', { printer: id })).data;
	assert.ok(imp.imported >= 2 || hist.some((r) => r.source === 'import'), JSON.stringify(imp));
	const all = (await admin.get(`/api/history?printer=${id}`)).data.items;
	assert.ok(all.some((r) => r.source === 'import' && r.file === 'first_layer.gcode' && r.result === 'cancelled'), 'imported from server.history');

	log('controls: macros, jog, emergency stop and firmware restart');
	const info = (await operator.get(`${base}/control`)).data;
	assert.deepEqual(info.controls[0].children.map((c) => c.name), ['CLEAN_NOZZLE', 'PREHEAT_PLA']);
	assert.equal(info.profile.volume.width, 250);
	assert.equal((await operator.post(`${base}/control`, { action: 'home', axes: ['x', 'y', 'z'] })).status, 200);
	assert.equal((await operator.post(`${base}/control`, { action: 'jog', x: 10 })).status, 200);
	assert.ok(mr.gcode.includes('G91\nG1 X10 F6000\nG90'));
	assert.equal((await operator.get(`${base}/timelapse`)).status, 400, 'OctoPrint-only routes refuse Klipper printers');
	await dark.goto(`${APP}/p/${id}?tab=control`);
	await dark.getByRole('heading', { name: 'Macros' }).waitFor();
	await sleep(500);
	await shot(dark, 'control-klipper');
	await dark.getByRole('button', { name: 'Stop', exact: true }).click();
	await dark.getByRole('dialog').getByRole('button', { name: 'Emergency stop' }).click();
	await waitFor(() => mr.state.klippy === 'shutdown', 'emergency stop');
	assert.ok(mr.calls.some((c) => c.path === '/printer/emergency_stop'));
	await dark.getByTestId('firmware-restart').waitFor({ timeout: 15_000 });
	await dark.getByTestId('firmware-restart').click();
	await waitFor(async () => (await admin.get('/api/printers/status')).data.find((s) => s.id === id)?.state === 'operational', 'ready again', { tries: 40 });

	log('a keyed Klipper printer added over the API; its websocket uses a one-shot token');
	const k = await admin.post('/api/printers', { name: 'Ender 3 (Klipper)', kind: 'moonraker', baseUrl: keyed.url, apiKey: KEY, color: 'amber' });
	assert.equal(k.status, 201, JSON.stringify(k.data));
	assert.equal(k.data.kind, 'moonraker');
	log('the keyed printer works too');
	await waitFor(async () => (await admin.get('/api/printers/status')).data.find((s) => s.id === k.data.id)?.state === 'operational', 'keyed printer ready');
	const audit = (await admin.get('/api/audit?limit=100')).data;
	for (const a of ['printer.create', 'job.start', 'job.pause', 'job.resume', 'job.cancel', 'printer.emergency_stop', 'printer.firmware_restart']) assert.ok(audit.some((e) => e.action === a), a);

	for (const pg of [dark, light]) assert.deepEqual(pg.errors, [], 'no browser errors');
	log('all Klipper e2e checks passed');
	if (process.env.E2E_APPLOG) console.log(appLog);
}

async function cleanup() {
	await browser?.close().catch(() => {});
	if (process.env.E2E_KEEP) {
		log(`E2E_KEEP: app still running on ${APP} (pid ${app?.pid}), data in ${dataDir}`);
		return;
	}
	app?.kill();
	for (const m of mocks) await m.close?.().catch?.(() => {});
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
