// End-to-end test of the bed mesh view, against local mocks only: a mock OctoPrint with the
// Bed Visualizer plugin (and a push socket), one without it, and a webhook catcher. No real
// printer or service is contacted.
//
//   pnpm e2e:bedmesh                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:bedmesh        # leave the app and mocks running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:bedmesh  # reuse ./build
//
// Ports 5400–5403 (E2E_PORT_BASE moves them): app +0, OctoPrint +1 (plugin) and +2 (none), webhook +3.
// Needs a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { demoMesh, startMockOctoPrint } from './mock-octoprint.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const PORT_BASE = Number(process.env.E2E_PORT_BASE ?? 5400);
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
const hooks = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-bedmesh-'));

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

/** A bed that slowly warps: each probe run bows it a little more and lifts the back-left corner. */
const meshOfWeek = (week) => demoMesh(7, { bow: 0.06 + week * 0.006, tilt: 0.01 * Math.sin(week), seed: week + 1 });

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting mock OctoPrint servers and a webhook catcher');
	const mk4Op = await startMockOctoPrint({
		port: PORT_BASE + 1,
		apiKey: 'mk4-bed-key',
		push: true,
		connectMs: 300,
		printSeconds: 60,
		bedVisualizer: { mesh: meshOfWeek(0), timestamp: '01/08/2026, 09:00:00', delayMs: 3500, nextMesh: () => demoMesh(7, { bow: 0.16, tilt: 0.04, seed: 9 }), bed: { type: 'rectangular', x_min: 10, x_max: 240, y_min: 10, y_max: 200, z_min: 0, z_max: 2 } }
	});
	const enderOp = await startMockOctoPrint({ port: PORT_BASE + 2, apiKey: 'ender-bed-key', connectMs: 300 });
	const hookServer = createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			hooks.push(JSON.parse(body));
			res.end('ok');
		});
	});
	await new Promise((r) => hookServer.listen(PORT_BASE + 3, '127.0.0.1', r));
	closers.push(mk4Op.close, enderOp.close, () => (hookServer.closeAllConnections(), new Promise((r) => hookServer.close(r))));
	for (const [op, key] of [
		[mk4Op, 'mk4-bed-key'],
		[enderOp, 'ender-bed-key']
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
	const mk4 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: mk4Op.url, apiKey: 'mk4-bed-key', color: 'violet' })).data;
	const ender = (await admin.post('/api/printers', { name: 'Ender 3', baseUrl: enderOp.url, apiKey: 'ender-bed-key', color: 'amber' })).data;
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
	await waitFor(async () => (await stateOf(mk4.id)) === 'operational' && (await stateOf(ender.id)) === 'operational', 'both printers ready');

	// --- detection -------------------------------------------------------------------------------
	log('detection: the MK4 has the plugin, the Ender doesn’t');
	let r = await viewer.get(`/api/printers/${mk4.id}/bedmesh`);
	assert.equal(r.status, 200, r.text);
	assert.equal(r.data.plugin.installed, true);
	assert.deepEqual(r.data.plugin.commands, ['G28', 'G29 T']);
	assert.equal(r.data.history.length, 1, 'the plugin’s stored mesh is picked up');
	assert.equal(r.data.latest.source, 'octoprint');
	assert.equal((await viewer.get(`/api/printers/${ender.id}/bedmesh`)).data.plugin.installed, false);
	assert.equal((await client().get(`/api/printers/${mk4.id}/bedmesh`)).status, 401);

	// History: a few months of weekly meshes (probed from OctoPrint's own UI), dated back for the demo.
	log('history: weekly meshes from OctoPrint');
	for (let week = 1; week <= 9; week++) {
		await fetch(`${mk4Op.url}/__mock/bedmesh`, { method: 'POST', body: JSON.stringify({ mesh: meshOfWeek(week) }) });
		assert.equal((await admin.get(`/api/printers/${mk4.id}/bedmesh?refresh=1`)).data.history.length, week + 1);
	}
	{
		const db = new DatabaseSync(join(dataDir, 'octo-modern.db'));
		const ids = db.prepare('SELECT id FROM bed_meshes WHERE printer_id = ? ORDER BY id').all(mk4.id).map((x) => x.id);
		ids.forEach((id, i) => {
			const at = new Date(Date.now() - (ids.length - i) * 7 * 86_400_000 - 3 * 3600_000).toISOString();
			db.prepare('UPDATE bed_meshes SET created_at = ?, last_seen_at = ? WHERE id = ?').run(at, at, id);
		});
		db.close();
	}

	// --- permissions and refusals ------------------------------------------------------------------
	log('update: viewers can’t, printing refuses, otherwise it asks first');
	assert.equal((await viewer.post(`/api/printers/${mk4.id}/bedmesh`, { action: 'update', confirm: true })).status, 403);
	assert.equal((await viewer.put(`/api/printers/${mk4.id}/bedmesh`, { enabled: true, maxFlatness: 0.2 })).status, 403);
	assert.equal((await operator.post(`/api/printers/${ender.id}/bedmesh`, { action: 'update', confirm: true })).status, 400, 'no plugin');
	await fetch(`${mk4Op.url}/__mock/print?file=bracket.gcode`);
	await waitFor(async () => (await stateOf(mk4.id)) === 'printing', 'MK4 printing');
	r = await operator.post(`/api/printers/${mk4.id}/bedmesh`, { action: 'update', confirm: true });
	assert.equal(r.status, 409);
	assert.ok(!r.data.confirmRequired, 'while printing it is refused, not confirmable');
	assert.match(r.data.message, /print is running/);
	assert.equal((await operator.post(`/api/printers/${mk4.id}/job`, { command: 'cancel', confirm: true })).status, 200);
	await waitFor(async () => (await stateOf(mk4.id)) === 'operational', 'MK4 idle again');
	r = await operator.post(`/api/printers/${mk4.id}/bedmesh`, { action: 'update' });
	assert.equal(r.status, 409);
	assert.equal(r.data.confirmRequired, true);
	assert.match(r.data.message, /G28 · G29 T/);
	assert.ok(!mk4Op.state.commands.includes('@BEDLEVELVISUALIZER'), 'nothing sent before confirming');
	await mk4Op.state.commands.splice(0);

	// --- drift alerts --------------------------------------------------------------------------------
	log('drift alerts: settings and a webhook rule for bed.drift');
	const hookChannel = await admin.post('/api/settings/notifications/channels', { type: 'webhook', name: 'e2e hook', secrets: { url: `http://127.0.0.1:${PORT_BASE + 3}/bed` } });
	assert.equal(hookChannel.status, 201, hookChannel.text);
	const rules = await admin.put('/api/settings/notifications', { rules: [{ name: 'Bed', printers: 'all', events: ['bed.drift'], channels: [hookChannel.data.channel.id] }] });
	assert.equal(rules.status, 200, rules.text);
	assert.deepEqual(rules.data.rules[0].events, ['bed.drift']);
	assert.equal((await operator.put(`/api/printers/${mk4.id}/bedmesh`, { enabled: true, maxFlatness: null, maxChange: null })).status, 400);
	r = await operator.put(`/api/printers/${mk4.id}/bedmesh`, { enabled: true, maxFlatness: 0.2, maxChange: 0.08 });
	assert.equal(r.status, 200, r.text);
	assert.ok((await audits('bedmesh.settings')).some((e) => e.userEmail === OPERATOR.email && /flatness ≤ 0.2 mm/.test(e.detail)));

	// --- browser ------------------------------------------------------------------------------------------
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
	const shot = async (page, name, opts = {}) => {
		await page.screenshot({ path: join(SHOTS, `${name}.png`), ...opts });
		log(`  screenshot ${name}.png`);
	};

	log('browser: no Bed mesh view without the plugin; a hint in the printer settings');
	const adminPage = await newPage('dark');
	await signIn(adminPage, ADMIN);
	await adminPage.goto(`${APP}/p/${ender.id}`);
	await adminPage.waitForSelector('nav[aria-label="Printer sections"]');
	await adminPage.click('nav[aria-label="Printer sections"] button:has-text("Care")');
	await adminPage.waitForURL(/tab=care/);
	await adminPage.waitForSelector('nav[aria-label="Printer sections"] [aria-current=page]:has-text("Care")');
	await sleep(500);
	assert.equal(await adminPage.locator('[data-testid=segmented] :text("Bed mesh")').count(), 0, 'no Bed mesh view without the plugin');
	// The old ?tab=bed lands on Care (its Bed mesh view doesn't exist here).
	await adminPage.goto(`${APP}/p/${ender.id}?tab=bed`);
	await adminPage.waitForSelector('nav[aria-label="Printer sections"] [aria-current=page]:has-text("Care")');
	await adminPage.waitForURL((u) => u.searchParams.get('tab') === 'care' && !u.searchParams.has('view'));
	await adminPage.click('button[aria-label="Edit server"]');
	await adminPage.waitForSelector('dialog[open] [data-testid=bedmesh-hint]');
	await adminPage.keyboard.press('Escape');
	await adminPage.goto(`${APP}/p/${mk4.id}`);
	await adminPage.click('button[aria-label="Edit server"]');
	await adminPage.waitForSelector('dialog[open] [data-testid=power-setup]');
	await sleep(500);
	assert.equal(await adminPage.locator('dialog[open] [data-testid=bedmesh-hint]').count(), 0, 'no hint where the plugin is installed');
	await adminPage.keyboard.press('Escape');

	log('browser: Care › Bed mesh, Update mesh with confirmation and progress');
	const dark = await newPage('dark');
	await signIn(dark, OPERATOR);
	await dark.goto(`${APP}/p/${mk4.id}`);
	await dark.click('nav[aria-label="Printer sections"] button:has-text("Care")');
	await dark.click('[data-testid=segmented] button:has-text("Bed mesh")');
	await dark.waitForURL(/tab=care&view=bed/);
	await dark.waitForSelector('[data-testid=mesh-heatmap] [data-max]');
	await dark.waitForSelector('[data-testid=mesh-surface] canvas');
	const flat0 = await dark.textContent('[data-testid=mesh-flatness]');
	assert.match(flat0, /0\.\d{3}/);
	// Rotate the 3D view by dragging.
	const surface = await dark.locator('[data-testid=mesh-surface] canvas').boundingBox();
	await dark.mouse.move(surface.x + surface.width / 2, surface.y + surface.height / 2);
	await dark.mouse.down();
	await dark.mouse.move(surface.x + surface.width / 2 + 60, surface.y + surface.height / 2 + 15, { steps: 6 });
	await dark.mouse.up();
	await dark.click('[data-testid=mesh-update]');
	await dark.waitForSelector('dialog[open] >> text=Probe the bed of Prusa MK4?');
	await sleep(300);
	await shot(dark, 'bedmesh-confirm');
	await dark.click('dialog[open] button:has-text("Probe bed")');
	await dark.waitForSelector('[data-testid=mesh-progress]');
	assert.deepEqual(mk4Op.state.commands, ['@BEDLEVELVISUALIZER', 'G28', 'G29 T']);
	await dark.waitForSelector('[data-testid=mesh-progress]:has-text("Probing the bed")');
	await sleep(400);
	await shot(dark, 'bedmesh-updating');
	await dark.waitForSelector('[data-testid=mesh-progress]', { state: 'detached', timeout: 20_000 });
	await dark.waitForSelector('text=New bed mesh');
	await dark.waitForSelector('[data-testid=mesh-drift-flag]');
	const latest = (await admin.get(`/api/printers/${mk4.id}/bedmesh`)).data;
	assert.equal(latest.history.length, 11);
	assert.equal(latest.latest.source, 'update');
	assert.equal(latest.latest.drift, true);
	assert.equal(latest.update.phase, 'done');
	assert.ok((await audits('bedmesh.update')).some((e) => e.userEmail === OPERATOR.email));
	const hook = await waitFor(() => hooks.find((h) => h.event === 'bed.drift'), 'bed.drift webhook');
	assert.match(hook.message, /Prusa MK4: Flatness 0\.\d{3} mm is over the 0\.200 mm limit/);
	assert.ok(mk4Op.state.settingsWrites.some((w) => w.plugins?.bedlevelvisualizer?.stored_mesh?.length === 7), 'mesh written back to the plugin');
	await dark.waitForSelector('[data-testid=mesh-diff]');
	assert.match(await dark.textContent('[data-testid=diff-max]'), /0\.\d{3} mm/);
	// Back to the default 3D view, and let the toast go.
	await dark.dblclick('[data-testid=mesh-surface] [role=application]');
	await dark.waitForSelector('text=New bed mesh', { state: 'detached', timeout: 10_000 });
	await sleep(400);
	await shot(dark, 'bedmesh');
	await dark.locator('[data-testid=mesh-compare]').scrollIntoViewIfNeeded();
	await sleep(400);
	await shot(dark, 'bedmesh-compare');
	// Pick another pair to compare.
	const options = await dark.locator('[data-testid=compare-from] option').evaluateAll((os) => os.map((o) => o.value));
	await dark.selectOption('[data-testid=compare-from]', options[3]);
	await dark.waitForSelector('[data-testid=mesh-diff]');

	log('browser: light theme, viewer, phone');
	const light = await newPage('light');
	await signIn(light, ADMIN);
	await light.goto(`${APP}/p/${mk4.id}?tab=bed`);
	await light.waitForSelector('[data-testid=mesh-heatmap] [data-max]');
	await sleep(800);
	await shot(light, 'bedmesh-light');

	const viewPage = await newPage('dark');
	await signIn(viewPage, VIEWER);
	await viewPage.goto(`${APP}/p/${mk4.id}?tab=bed`);
	await viewPage.waitForSelector('[data-testid=mesh-heatmap]');
	assert.equal(await viewPage.locator('[data-testid=mesh-update]').count(), 0, 'viewers get no Update button');
	assert.equal(await viewPage.locator('[data-testid=drift-save]').count(), 0);

	const phone = await newPage('dark', 390, 844);
	await signIn(phone, OPERATOR);
	await phone.goto(`${APP}/p/${mk4.id}?tab=bed`);
	await phone.waitForSelector('[data-testid=mesh-heatmap] [data-max]');
	const btn = await phone.locator('[data-testid=mesh-update]').boundingBox();
	assert.ok(btn && btn.x + btn.width <= 390, 'Update button on screen');
	assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
	for (const sel of ['[data-testid=mesh-heatmap]', '[data-testid=mesh-surface]', '[data-testid=mesh-compare]', '[data-testid=mesh-history]']) {
		const box = await phone.locator(sel).boundingBox();
		assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${sel} fits the phone (${JSON.stringify(box)})`);
	}
	await sleep(600);
	await shot(phone, 'mobile-bedmesh');
	const phoneLight = await newPage('light', 390, 844);
	await signIn(phoneLight, OPERATOR);
	await phoneLight.goto(`${APP}/p/${mk4.id}?tab=bed`);
	await phoneLight.waitForSelector('[data-testid=mesh-surface] canvas');
	await phoneLight.locator('[data-testid=mesh-surface]').scrollIntoViewIfNeeded();
	await sleep(600);
	await shot(phoneLight, 'mobile-bedmesh-light');

	// Delete a mesh, set a reference.
	const victim = latest.history.at(-2);
	assert.equal((await viewer.del(`/api/printers/${mk4.id}/bedmesh/${victim.id}`)).status, 403);
	assert.equal((await operator.del(`/api/printers/${mk4.id}/bedmesh/${victim.id}`)).status, 200);
	assert.equal((await operator.get(`/api/printers/${mk4.id}/bedmesh/${victim.id}`)).status, 404);
	assert.equal((await operator.get(`/api/printers/${ender.id}/bedmesh/${latest.latest.id}`)).status, 404, 'meshes belong to their printer');
	r = await operator.put(`/api/printers/${mk4.id}/bedmesh`, { referenceId: latest.history[3].id });
	assert.equal(r.data.referenceId, latest.history[3].id);
	assert.ok((await audits('bedmesh.delete')).length === 1);

	for (const p of [adminPage, dark, light, viewPage, phone, phoneLight]) assert.deepEqual(p.errors, [], 'no browser errors');
	log('all bed mesh e2e checks passed');
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
