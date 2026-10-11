// End-to-end test of Spoolman spools, print costs and maintenance reminders, against real
// OctoPrint servers (virtual printers in Docker, one with two extruders) and a mock Spoolman.
//
//   pnpm e2e:spools                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:spools        # leave the containers and app running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:spools  # reuse ./build
//
// Ports (override with the env vars): app 3220, mock Spoolman 3221, OctoPrint 3222–3223, webhook 3224.
// Needs Docker and a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMockSpoolman } from './mock-spoolman.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3220);
const APP = `http://127.0.0.1:${APP_PORT}`;
const SPOOLMAN_PORT = Number(process.env.E2E_SPOOLMAN_PORT ?? 3221);
const OP_BASE = Number(process.env.E2E_OP_PORT_BASE ?? 3222);
const HOOK_PORT = Number(process.env.E2E_HOOK_PORT ?? 3224);
const OP_PREFIX = process.env.E2E_OP_PREFIX ?? 'octo-modern-spools-e2e-op';
const OP = [1, 2].map((i) => ({ url: `http://127.0.0.1:${OP_BASE + i - 1}`, key: `ocm-dev-key-${i}` }));
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };
const SPOOLMAN_AUTH = 'Bearer e2e-spoolman-token';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const opEnv = { ...process.env, OCM_OP_PORT_BASE: String(OP_BASE), OCM_OP_PREFIX: OP_PREFIX };
const devOctoprint = (...args) => execFileSync(join(ROOT, 'scripts/dev-octoprint.sh'), args, { env: opEnv, stdio: 'inherit' });
const near = (a, b, tol, label) => assert.ok(a != null && Math.abs(a - b) <= tol, `${label}: ${a} vs ${b} (±${tol})`);
const gramsFromMm = (mm, density, diameter = 1.75) => ((mm * Math.PI * (diameter / 2) ** 2) / 1000) * density;

let app;
let browser;
let spoolman;
let hookServer;
let stopping = false;
const hooks = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-spools-'));
const libDir = join(dataDir, 'library');

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
	throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}${last.cause ? ` (${last.cause.code ?? last.cause.message})` : ''}` : ''}`);
}

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
		return { status: res.status, data: await res.json().catch(() => null) };
	};
	return {
		get: (p, o) => call('GET', p, undefined, o),
		post: (p, b) => call('POST', p, b ?? {}),
		put: (p, b) => call('PUT', p, b),
		patch: (p, b) => call('PATCH', p, b),
		del: (p) => call('DELETE', p, {})
	};
}

/** About `seconds` of printing that extrudes `perSecond` mm a second; `tools` alternates extruders (T0/T1). */
function timedGcode(seconds, { perSecond = 60, tools = 1 } = {}) {
	const lines = ['; octo-modern spools e2e', 'G21', 'G90', 'M83', 'G28', 'G1 Z0.2 F600'];
	for (let i = 0; i < seconds; i++) {
		if (tools > 1) lines.push(`T${i % tools}`);
		lines.push(`G1 X${20 + (i % 10) * 8} Y${20 + Math.floor(i / 10) * 8} E${perSecond} F1800`);
		lines.push('G4 P1000');
	}
	lines.push('M84');
	return lines.join('\n') + '\n';
}

/** A file that needs a lot of filament but prints in no time (the analysis counts the E moves). */
function hungryGcode(metres) {
	const lines = ['; needs a whole spool', 'G21', 'G90', 'M83', 'G28'];
	for (let i = 0; i < 10; i++) lines.push(`G1 X${10 + i} Y10 E${(metres * 1000) / 10} F1800`);
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

async function upload(o, name, content) {
	const fd = new FormData();
	fd.set('file', new Blob([content]), name);
	const res = await fetch(`${o.url}/api/files/local`, { method: 'POST', headers: { 'X-Api-Key': o.key }, body: fd });
	assert.equal(res.status, 201, `upload to OctoPrint: ${await res.text()}`);
	return waitFor(async () => (await op(o, 'GET', `/api/files/local/${encodeURIComponent(name)}`)).gcodeAnalysis?.filament, `analysis of ${name}`);
}

const opState = async (o) => (await op(o, 'GET', '/api/job')).state;

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	mkdirSync(libDir, { recursive: true });
	// A library file whose slicer says it needs 450 g (more than spool 3 holds).
	writeFileSync(join(libDir, 'Big_vase_PLA_0.28mm.gcode'), `; generated by PrusaSlicer 2.8.1\n${timedGcode(2)}; filament used [mm] = 150960.00\n; filament used [g] = 450.20\n; filament_type = PLA\n; estimated printing time (normal mode) = 9h 12m 3s\n`);

	log('starting two OctoPrint servers with virtual printers');
	devOctoprint('up', '2');
	// The second has two extruders (an IDEX).
	await op(OP[1], 'POST', '/api/settings', { plugins: { virtual_printer: { numExtruders: 2, sharedNozzle: false } } });
	await op(OP[1], 'PATCH', '/api/printerprofiles/_default', { profile: { extruder: { count: 2, offsets: [[0, 0], [0, 0]] } } });
	await op(OP[1], 'POST', '/api/connection', { command: 'disconnect' });
	await sleep(1000);
	await op(OP[1], 'POST', '/api/connection', { command: 'connect', port: 'VIRTUAL', baudrate: 0 });
	await waitFor(async () => (await op(OP[1], 'GET', '/api/printer')).temperature?.tool1, 'two extruders');

	spoolman = await startMockSpoolman({ port: SPOOLMAN_PORT, auth: SPOOLMAN_AUTH });
	log(`mock Spoolman on ${spoolman.url}`);
	hookServer = createServer((req, res) => {
		let b = '';
		req.on('data', (d) => (b += d));
		req.on('end', () => {
			hooks.push(JSON.parse(b));
			res.end('ok');
		});
	});
	await new Promise((r) => hookServer.listen(HOOK_PORT, '127.0.0.1', r));

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
	app.on('exit', (code, signal) => !stopping && console.error(`✗ the app exited (${code ?? signal})\n${appLog.slice(-3000)}`));
	process.on('exit', () => {
		try {
			writeFileSync(join(dataDir, 'app.log'), appLog);
		} catch {}
	});
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');

	const admin = client();
	assert.equal((await admin.post('/api/auth/login', ADMIN)).status, 200);
	const mk4 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: OP[0].url, apiKey: OP[0].key, color: 'violet' })).data;
	const idex = (await admin.post('/api/printers', { name: 'Sovol SV04 IDEX', baseUrl: OP[1].url, apiKey: OP[1].key, color: 'cyan' })).data;
	for (const u of [
		{ ...OPERATOR, role: 'operator' },
		{ ...VIEWER, role: 'viewer' }
	]) assert.equal((await admin.post('/api/users', u)).status, 201);
	const operator = client();
	const viewer = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);
	await waitFor(async () => (await admin.get('/api/printers/status')).data.every((s) => s.state === 'operational'), 'both printers ready');
	assert.equal((await admin.post('/api/library/sources', { name: 'NAS prints', kind: 'folder', config: { path: libDir } })).status, 201);
	const lib = (await admin.get('/api/library/sources')).data[0];
	const hookChannel = await admin.post('/api/settings/notifications/channels', { type: 'webhook', name: 'e2e', secrets: { url: `http://127.0.0.1:${HOOK_PORT}/` } });
	assert.equal(hookChannel.status, 201, JSON.stringify(hookChannel.data));
	const rules = await admin.put('/api/settings/notifications', { rules: [{ name: 'Spools and maintenance', printers: 'all', events: ['success', 'spool.low', 'maintenance.due'], channels: [hookChannel.data.channel.id] }] });
	assert.equal(rules.status, 200, JSON.stringify(rules.data));

	// --- Spoolman connection --------------------------------------------------------------------
	log('Spoolman: admin-only settings, sealed auth header, test');
	assert.equal((await operator.get('/api/settings/spoolman')).status, 403);
	assert.equal((await operator.put('/api/settings/spoolman', { url: spoolman.url })).status, 403);
	assert.equal((await viewer.get('/api/spools')).data.configured, false);
	assert.equal((await admin.put('/api/settings/spoolman', { url: 'ftp://nope' })).status, 400);
	let s = await admin.put('/api/settings/spoolman', { url: `${spoolman.url}/api/v1`, authHeader: 'Authorization', authValue: 'Bearer wrong', lowThresholdG: 100 });
	assert.equal(s.status, 200);
	assert.equal(s.data.url, spoolman.url);
	assert.ok(!JSON.stringify(s.data).includes('wrong'), 'the header value never comes back');
	assert.match((await admin.post('/api/settings/spoolman/test')).data.message, /refused/);
	s = await admin.put('/api/settings/spoolman', { url: spoolman.url, authHeader: 'Authorization', authValue: SPOOLMAN_AUTH, lowThresholdG: 100 });
	const t = (await admin.post('/api/settings/spoolman/test')).data;
	assert.deepEqual(t, { ok: true, version: '0.22.1', spools: 6 });
	assert.equal(spoolman.requests.at(-1).headers.authorization, SPOOLMAN_AUTH);
	const list = (await viewer.get('/api/spools')).data;
	assert.equal(list.spools.length, 6, 'viewers can browse spools (archived ones left out)');

	// --- costs ---------------------------------------------------------------------------------
	assert.equal((await operator.put('/api/settings/costs', {})).status, 403);
	const costCfg = (await admin.get('/api/settings/costs')).data;
	const saved = await admin.put('/api/settings/costs', { ...costCfg, currency: 'EUR', electricityPerKwh: 0.32, defaultPowerW: 120, printerPowerW: { [mk4.id]: 90 } });
	assert.equal(saved.status, 200, JSON.stringify(saved.data));

	// --- assigning spools -----------------------------------------------------------------------
	log('assigning spools: operators yes, viewers no; one spool on one tool at a time');
	assert.equal((await viewer.put(`/api/printers/${mk4.id}/spools`, { tool: 0, spoolId: 1 })).status, 403);
	assert.equal((await operator.put(`/api/printers/${mk4.id}/spools`, { tool: 0, spoolId: 999 })).status, 400);
	assert.equal((await operator.put(`/api/printers/${mk4.id}/spools`, { tool: 0, spoolId: 1 })).status, 200);
	assert.equal((await operator.put(`/api/printers/${idex.id}/spools`, { tool: 0, spoolId: 2 })).status, 200);
	const idexSpools = (await operator.put(`/api/printers/${idex.id}/spools`, { tool: 1, spoolId: 4 })).data;
	assert.equal(idexSpools.tools, 2, 'two extruders seen');
	assert.deepEqual(
		idexSpools.assignments.map((a) => [a.tool, a.spool.name]),
		[
			[0, 'Prusa Orange'],
			[1, 'PolyLite Teal']
		]
	);
	assert.ok((await admin.get('/api/audit?action=spool.assign')).data.length === 3, 'assignments are audited');

	// --- pre-print check -------------------------------------------------------------------------
	log('pre-print check: job start, print file and library send-and-print ask first');
	await upload(OP[0], 'whole-spool.gcode', hungryGcode(400));
	let r = await operator.post(`/api/printers/${mk4.id}/files/select`, { origin: 'local', path: 'whole-spool.gcode', print: true });
	assert.equal(r.status, 409);
	assert.equal(r.data.confirmRequired, true);
	assert.match(r.data.message, /^Galaxy Black \(PLA\) has 688 g \/ 230\.\d m left; this print needs about 1193 g \/ 400\.0 m\. Start anyway\?$/);
	assert.equal(await opState(OP[0]), 'Operational', 'nothing started');
	// Selected (not printing): the job start asks too.
	assert.equal((await operator.post(`/api/printers/${mk4.id}/files/select`, { origin: 'local', path: 'whole-spool.gcode', print: false })).status, 200);
	await sleep(500);
	r = await operator.post(`/api/printers/${mk4.id}/job`, { command: 'start' });
	assert.equal(r.status, 409);
	assert.equal(r.data.title, 'Not enough filament');
	// Library send-and-print: the slicer's 450 g against spool 3 (94.8 g).
	assert.equal((await operator.put(`/api/printers/${mk4.id}/spools`, { tool: 0, spoolId: 3 })).status, 200);
	r = await operator.post(`/api/library/${lib.id}/send`, { path: 'Big_vase_PLA_0.28mm.gcode', printerId: mk4.id, print: true });
	assert.equal(r.status, 409);
	assert.equal(r.data.filament, true);
	assert.match(r.data.message, /PolyTerra Cotton White \(PLA\) has 95 g .* needs about 450 g/);
	// spool.low: spool 3 was already below 100 g when it went on.
	await waitFor(() => hooks.find((h) => h.event === 'spool.low'), 'a spool.low notification');
	assert.match(hooks.find((h) => h.event === 'spool.low').message, /PolyTerra Cotton White \(PLA\) on Prusa MK4 is down to 95 g/);
	assert.equal((await operator.put(`/api/printers/${mk4.id}/spools`, { tool: 0, spoolId: 1 })).status, 200);

	// --- maintenance -------------------------------------------------------------------------------
	log('maintenance: tasks, access, defaults');
	assert.equal((await viewer.post(`/api/printers/${mk4.id}/maintenance`, { defaults: true })).status, 403);
	const since = new Date(Date.now() - 20 * 86_400_000).toISOString();
	r = await operator.post(`/api/printers/${mk4.id}/maintenance`, { defaults: true, lastDoneAt: since });
	assert.equal(r.status, 201);
	assert.equal(r.data.added.length, 5);
	// One that the next print makes overdue: every 30 print seconds.
	const bolts = (await operator.post(`/api/printers/${mk4.id}/maintenance`, { name: 'Check frame bolts', metric: 'hours', interval: 0.008, notes: 'M3 and M5 frame screws' })).data;
	assert.equal(bolts.status, 'ok');
	assert.equal((await operator.post(`/api/printers/${mk4.id}/maintenance`, { name: 'x', metric: 'weeks', interval: 1 })).status, 400);
	const tasks = (await viewer.get(`/api/printers/${mk4.id}/maintenance`)).data.tasks;
	assert.equal(tasks.find((x) => x.name === 'Clean the bed').status, 'overdue', '20 days since, every 7');
	assert.equal((await viewer.get('/api/maintenance')).data.overdue, 1);
	await waitFor(() => hooks.find((h) => h.event === 'maintenance.due'), 'maintenance.due for the bed', { tries: 80 }).catch(() => null);

	// --- a print: progressive + final reports, cost, maintenance ------------------------------------
	log('printing on the MK4: filament reported while it prints and at the end, then costed');
	const usesBefore = spoolman.uses.length;
	const weightBefore = spoolman.spool(1).used_weight;
	await upload(OP[0], 'bracket.gcode', timedGcode(50, { perSecond: 60 })); // 3 m in ~50 s
	assert.equal((await operator.post(`/api/printers/${mk4.id}/files/select`, { origin: 'local', path: 'bracket.gcode', print: true })).status, 200);
	await waitFor(async () => (await opState(OP[0])).startsWith('Printing'), 'printing', { every: 100 });
	await waitFor(() => spoolman.uses.length > usesBefore, 'a report while printing', { tries: 100 });
	assert.ok((await opState(OP[0])).startsWith('Printing'), 'reported before the end');
	await waitFor(async () => (await opState(OP[0])) === 'Operational', 'the print ended', { tries: 200 });
	const entry = await waitFor(async () => (await viewer.get(`/api/history?printer=${mk4.id}&q=bracket`)).data.items.find((e) => e.result === 'success' && e.cost != null), 'the costed entry', { tries: 60 });
	const reported = spoolman.uses.slice(usesBefore);
	assert.ok(reported.length >= 2, `progressive + final (${reported.length})`);
	assert.ok(reported.every((u) => u.id === 1 && u.body.use_length > 0));
	near(
		reported.reduce((a, u) => a + u.body.use_length, 0),
		entry.filamentMm,
		0.05,
		'Spoolman heard exactly what the history recorded'
	);
	near(spoolman.spool(1).used_weight - weightBefore, gramsFromMm(entry.filamentMm, 1.24), 0.01, 'Spoolman’s spool');
	near(entry.filamentG, gramsFromMm(entry.filamentMm, 1.24), 0.01, 'grams');
	near(entry.costFilament, (entry.filamentG / 1000) * 29.99, 0.001, 'filament cost from the spool’s price');
	near(entry.costEnergy, (entry.durationS / 3600) * 0.09 * 0.32, 0.0001, 'electricity at 90 W');
	assert.equal(entry.material, 'PLA');
	const due = await waitFor(() => hooks.find((h) => h.event === 'maintenance.due' && h.title.includes('frame bolts')), 'maintenance.due for the bolts', { tries: 40 });
	assert.match(due.message, /^Prusa MK4: “Check frame bolts” is due/);

	log('printing on the IDEX: each extruder’s spool gets its share');
	const idexUses = spoolman.uses.length;
	await upload(OP[1], 'two-colour.gcode', timedGcode(12, { perSecond: 50, tools: 2 }));
	const fil = (await op(OP[1], 'GET', '/api/files/local/two-colour.gcode')).gcodeAnalysis.filament;
	assert.ok(fil.tool0?.length > 0 && fil.tool1?.length > 0, `analysis per tool: ${JSON.stringify(fil)}`);
	assert.equal((await operator.post(`/api/printers/${idex.id}/files/select`, { origin: 'local', path: 'two-colour.gcode', print: true })).status, 200);
	await waitFor(async () => (await opState(OP[1])).startsWith('Printing'), 'IDEX printing', { every: 100 });
	await waitFor(async () => (await opState(OP[1])) === 'Operational', 'IDEX done', { tries: 200 });
	const idexEntry = await waitFor(async () => (await viewer.get(`/api/history?printer=${idex.id}`)).data.items.find((e) => e.result === 'success' && e.cost != null), 'the IDEX entry', { tries: 60 });
	const byspool = {};
	for (const u of spoolman.uses.slice(idexUses)) byspool[u.id] = (byspool[u.id] ?? 0) + u.body.use_length;
	near(byspool[2], fil.tool0.length, 0.05, 'tool 0 → spool 2');
	near(byspool[4], fil.tool1.length, 0.05, 'tool 1 → spool 4');
	near(idexEntry.costEnergy, (idexEntry.durationS / 3600) * 0.12 * 0.32, 0.0001, 'default 120 W');

	// --- history: stats and CSV carry the cost ------------------------------------------------------
	const stats = (await viewer.get('/api/history/stats')).data;
	assert.equal(stats.currency, 'EUR');
	assert.equal(stats.costed, 2);
	near(stats.cost, entry.cost + idexEntry.cost, 1e-6, 'total cost');
	near(stats.perPrinter.find((p) => p.printerId === mk4.id).cost, entry.cost, 1e-6, 'per printer');
	const csv = (await (await viewer.get('/api/history/export.csv', { raw: true })).text()).trim().split('\r\n');
	assert.match(csv[0], /,filament_g,material,cost_filament,cost_energy,cost_total$/);
	assert.ok(csv.some((l) => l.includes('bracket.gcode') && l.includes(',PLA,')));
	// Recalculating needs confirming and keeps spool prices.
	assert.equal((await admin.post('/api/settings/costs/recalculate', {})).status, 409);
	assert.equal((await admin.post('/api/settings/costs/recalculate', { confirm: true })).data.changed, 2);
	near((await viewer.get(`/api/history/${entry.id}`)).data.costFilament ?? entry.costFilament, entry.costFilament, 0.001, 'spool price kept');

	// --- browser ------------------------------------------------------------------------------------------
	log('browser: dashboard spool card, picker, warnings, filament and maintenance pages, screenshots');
	browser = await chromium.launch();
	const newPage = async (theme, viewport = { width: 1440, height: 900 }, extra = {}) => {
		const ctx = await browser.newContext({ viewport, deviceScaleFactor: extra.isMobile ? 2 : 1, colorScheme: theme, ...extra });
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

	const dark = await newPage('dark');
	await signIn(dark, OPERATOR);
	// Sidebar badge: the bed and the bolts are overdue.
	await dark.waitForSelector('[data-testid=maintenance-badge]');
	assert.equal((await dark.textContent('[data-testid=maintenance-badge]')).trim(), '2');

	await dark.goto(`${APP}/p/${idex.id}`);
	await dark.waitForSelector('[data-testid=spool-card] [data-tool="1"]');
	await sleep(1200);
	await shot(dark, 'spools-dashboard');
	// Pick another spool for tool 1 from the picker (search, swatches).
	await dark.click('[data-testid=spool-card] button[aria-label="Change spool of tool 1"]');
	await dark.waitForSelector('dialog[open] [data-spool="5"]');
	await dark.fill('dialog[open] input[aria-label="Search spools"]', 'silk');
	await dark.waitForFunction(() => !document.querySelector('dialog[open] [data-spool="4"]'));
	await sleep(300);
	await shot(dark, 'spool-picker');
	await dark.click('dialog[open] [data-spool="5"]');
	await dark.waitForSelector('[data-testid=spool-card] [data-tool="1"]:has-text("Silk Rainbow")');
	assert.equal((await operator.get(`/api/printers/${idex.id}/spools`)).data.assignments.find((a) => a.tool === 1).spoolId, 5);

	// Print from the Files tab: the filament warning, then back out.
	await dark.goto(`${APP}/p/${mk4.id}?tab=files`);
	await dark.waitForSelector('tr:has-text("whole-spool.gcode") button:has-text("Print")');
	await dark.click('tr:has-text("whole-spool.gcode") button:has-text("Print")');
	await dark.waitForSelector('dialog[open] >> text=Not enough filament');
	await sleep(300);
	await shot(dark, 'filament-warning');
	await dark.click('dialog[open] button:has-text("Cancel")');
	await sleep(500);
	assert.equal(await opState(OP[0]), 'Operational', 'backing out starts nothing');

	// Maintenance: mark the bolts done with a note.
	await dark.goto(`${APP}/maintenance`);
	await dark.waitForSelector('[data-task="Check frame bolts"][data-status="overdue"]');
	await sleep(600);
	await shot(dark, 'maintenance');
	await dark.click('button[aria-label="Mark Check frame bolts done"]');
	await dark.fill('#maintenance-notes', 'Two loose M5s on the gantry, re-torqued.');
	await sleep(300);
	await shot(dark, 'maintenance-done');
	await dark.click('dialog[open] button:has-text("Mark done")');
	await dark.waitForSelector('[data-task="Check frame bolts"][data-status="ok"]');
	await dark.waitForSelector('[data-testid=maintenance-log] >> text=Two loose M5s');
	assert.equal((await dark.textContent('[data-testid=maintenance-badge]')).trim(), '1', 'the badge follows');
	const logEntry = (await viewer.get('/api/maintenance')).data.log[0];
	assert.equal(logEntry.doneBy, OPERATOR.name);
	assert.equal(logEntry.taskName, 'Check frame bolts');
	assert.ok((await admin.get('/api/audit?action=maintenance.done')).data.length === 1, 'audited');

	// Printer tab and history with costs.
	await dark.goto(`${APP}/p/${mk4.id}?tab=maintenance`);
	await dark.waitForSelector('[data-task="Change nozzle"]');
	await dark.goto(`${APP}/history`);
	await dark.waitForSelector('tr[data-print="bracket.gcode"] td[data-cost]');
	await sleep(800);
	await shot(dark, 'history-costs');

	// Admin: the Filament page with the settings.
	const adminPage = await newPage('dark');
	await signIn(adminPage, ADMIN);
	await adminPage.goto(`${APP}/filament`);
	await adminPage.waitForSelector('#spoolman-url');
	await adminPage.waitForSelector('[data-testid=spool-card] [data-tool="0"]:has-text("Galaxy Black")');
	assert.equal(await adminPage.inputValue('#spoolman-url'), spoolman.url);
	await adminPage.click('#spoolman button:has-text("Test")');
	await adminPage.waitForSelector('[data-testid=spoolman-test]:has-text("6 spools")');
	await sleep(500);
	await shot(adminPage, 'filament');

	const light = await newPage('light');
	await signIn(light, ADMIN);
	await light.goto(`${APP}/filament`);
	await light.waitForSelector('[data-testid=spool-card] [data-tool="0"]:has-text("Galaxy Black")');
	await sleep(600);
	await shot(light, 'filament-light');
	await light.goto(`${APP}/maintenance`);
	await light.waitForSelector('[data-task="Check frame bolts"]');
	await sleep(600);
	await shot(light, 'maintenance-light');

	// Phones: no sideways scrolling on the new pages, at 390 px.
	const phone = await newPage('dark', { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
	await signIn(phone, OPERATOR);
	for (const [path, name, sel] of [
		['/filament', 'mobile-filament', '[data-testid=spool-card]'],
		['/maintenance', 'mobile-maintenance', '[data-task="Change nozzle"]'],
		[`/p/${mk4.id}`, 'mobile-spools-dashboard', '[data-testid=spool-card]']
	]) {
		await phone.goto(`${APP}${path}`);
		await phone.waitForSelector(sel);
		await sleep(700);
		const overflow = await phone.evaluate(() => [...document.querySelectorAll('main, main *')].some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.getBoundingClientRect().right > innerWidth + 1));
		assert.equal(overflow, false, `${path}: nothing wider than the screen`);
		assert.ok((await phone.evaluate(() => document.documentElement.scrollWidth)) <= 390, `${path}: no sideways scroll`);
		await shot(phone, name);
		if (path === '/maintenance') {
			const box = await phone.locator('button[aria-label="Mark Change nozzle done"]').first().boundingBox();
			assert.ok(box.height >= 44, `Done button is ${box.height}px tall on a phone`);
		}
	}

	for (const p of [dark, adminPage, light, phone]) assert.deepEqual(p.errors, [], 'no browser errors');
	log('all spools e2e checks passed');
}

async function cleanup(ok) {
	await browser?.close().catch(() => {});
	await spoolman?.close().catch(() => {});
	hookServer?.closeAllConnections?.();
	hookServer?.close();
	if (process.env.E2E_KEEP) {
		log(`E2E_KEEP: app still running on ${APP} (pid ${app?.pid}), data in ${dataDir}`);
		return;
	}
	stopping = true;
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
