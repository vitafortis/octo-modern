// End-to-end test of the Stats page: a year of seeded demo history on three mock OctoPrint
// printers (and one removed printer), a mock Spoolman, access per printer, the CSV export
// and screenshots (desktop dark and light, phone).
//
//   pnpm e2e:stats                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:stats        # leave the app running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:stats  # reuse ./build
//
// Ports (override with the env vars): app 5300, mock OctoPrint 5301–5303, mock Spoolman 5304.
// No Docker needed. Needs a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMockOctoPrint } from './mock-octoprint.mjs';
import { startMockSpoolman } from './mock-spoolman.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 5300);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_BASE = Number(process.env.E2E_OP_PORT_BASE ?? 5301);
const SPOOLMAN_PORT = Number(process.env.E2E_SPOOLMAN_PORT ?? 5304);
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

let app;
let browser;
let stopping = false;
const closers = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-stats-'));

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
		return { status: res.status, data, text, headers: res.headers };
	};
	return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}

/** Deterministic randomness, so the screenshots are stable from run to run. */
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FILES = [
	['3DBenchy_PLA_0.2mm.gcode', 1.1, 8],
	['Cable_clips_x12_PETG.gcode', 0.8, 6],
	['Voron_StealthBurner_ABS.gcode', 6.5, 3],
	['Gridfinity_bin_2x3_PLA.gcode', 2.4, 9],
	['Calibration_cube_20mm.gcode', 0.4, 5],
	['Planter_hex_vase_mode.gcode', 4.2, 4],
	['Raspberry_Pi_5_case.gcode', 3.1, 4],
	['Headphone_stand_PLA.gcode', 7.8, 2],
	['Filament_dryer_lid_ASA.gcode', 5.6, 2],
	['Desk_cable_tray_PETG.gcode', 3.6, 3],
	['Lithophane_family_photo.gcode', 9.5, 1],
	['Spool_holder_bearing.gcode', 1.9, 3],
	['Drawer_label_holders_x20.gcode', 1.4, 3],
	['Articulated_dragon_silk.gcode', 8.2, 2]
];
const FAIL_REASONS = ['error', 'error', 'disconnected', 'Thermal runaway', 'Filament runout'];

/** About 14 months of prints per printer, never overlapping on one printer. */
function demoHistory(printers, now) {
	const rand = rng(20261011);
	const pick = (list) => list[Math.floor(rand() * list.length)];
	const weighted = FILES.flatMap((f) => Array(f[2]).fill(f));
	const rows = [];
	for (const p of printers) {
		let t = now - (p.days ?? 425) * 86_400_000;
		const end = p.until ?? now - 2 * 3_600_000;
		while (t < end) {
			const [file, hours] = pick(weighted);
			const durationS = Math.round(hours * (0.8 + rand() * 0.4) * 3600);
			const r = rand();
			const result = r < 0.86 ? 'success' : r < 0.93 ? 'cancelled' : 'failed';
			const done = result === 'success' ? 1 : 0.1 + rand() * 0.7;
			const ran = Math.round(durationS * done);
			if (t + ran * 1000 > end) break;
			const mm = Math.round(hours * 1150 * done * (0.85 + rand() * 0.3));
			const material = pick(p.materials);
			const density = { PLA: 1.24, PETG: 1.27, ASA: 1.07, ABS: 1.04 }[material];
			const grams = (mm * Math.PI * 0.875 ** 2 * density) / 1000;
			const price = { PLA: 22, PETG: 24, ASA: 30, ABS: 24 }[material];
			rows.push({
				printer: p,
				file,
				startedAt: new Date(t).toISOString(),
				endedAt: new Date(t + ran * 1000).toISOString(),
				durationS: ran,
				result,
				reason: result === 'failed' ? pick(FAIL_REASONS) : null,
				mm,
				grams: Math.round(grams * 100) / 100,
				material,
				costFilament: Math.round((grams / 1000) * price * 10_000) / 10_000,
				costEnergy: Math.round((ran / 3600) * (p.watts / 1000) * 0.32 * 10_000) / 10_000,
				spool: p.spools[material]
			});
			t += ran * 1000 + (p.gapHours[0] + rand() * p.gapHours[1]) * 3_600_000;
		}
	}
	return rows;
}

function seed(dbPath, rows, now) {
	const db = new DatabaseSync(dbPath);
	db.exec('PRAGMA busy_timeout = 5000');
	const ins = db.prepare(
		`INSERT INTO prints (printer_id, printer_name, file_name, file_path, origin, started_at, ended_at, duration_s, result, reason, filament_mm, estimated_s, completion,
		   source, filament_g, material, cost_filament, cost_energy, cost_source)
		 VALUES (?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, 'material')`
	);
	const use = db.prepare(`INSERT INTO spool_usage (print_id, tool, spool_id, planned_mm, target_mm, reported_mm, final, updated_at) VALUES (?, 0, ?, ?, ?, ?, 1, ?)`);
	db.exec('BEGIN');
	for (const r of rows) {
		const { lastInsertRowid } = ins.run(
			r.printer.id,
			r.printer.name,
			r.file,
			r.file,
			r.startedAt,
			r.endedAt,
			r.durationS,
			r.result,
			r.reason,
			r.mm,
			r.durationS,
			r.result === 'success' ? 100 : 50,
			r.grams,
			r.material,
			r.costFilament,
			r.costEnergy
		);
		// Spoolman came along three months ago.
		if (r.spool && Date.parse(r.startedAt) > now - 90 * 86_400_000) use.run(Number(lastInsertRowid), r.spool, r.mm, r.mm, r.mm, r.endedAt);
	}
	db.exec('COMMIT');
	db.close();
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting three mock OctoPrint servers and a mock Spoolman');
	const ops = [];
	for (let i = 0; i < 3; i++) {
		const o = await startMockOctoPrint({ port: OP_BASE + i, apiKey: `stats-e2e-key-${i}` });
		ops.push(o);
		closers.push(o.close);
	}
	const spoolman = await startMockSpoolman({ port: SPOOLMAN_PORT });
	closers.push(spoolman.close);

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
	const add = async (name, i, color) => (await admin.post('/api/printers', { name, baseUrl: ops[i].url, apiKey: ops[i].apiKey, color })).data;
	const mk4 = await add('Prusa MK4', 0, 'violet');
	const voron = await add('Voron 2.4', 1, 'cyan');
	const ender = await add('Ender 3 S1', 2, 'amber');
	assert.equal((await admin.put('/api/settings/spoolman', { url: spoolman.url })).status, 200);
	assert.equal((await admin.post('/api/users', { ...VIEWER, role: 'viewer' })).status, 201);
	const vid = (await admin.get('/api/users')).data.find((u) => u.email === VIEWER.email).id;
	assert.equal((await admin.put(`/api/users/${vid}/access`, { printerAccess: 'selected', printers: [mk4.id] })).status, 200);
	const viewer = client();
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);

	log('seeding a year of demo history');
	const now = Date.now();
	const rows = demoHistory(
		[
			{ ...mk4, materials: ['PLA', 'PLA', 'PETG'], spools: { PLA: 1, PETG: 2 }, watts: 120, gapHours: [2, 26] },
			{ ...voron, materials: ['ABS', 'ASA', 'ASA'], spools: { ASA: 4 }, watts: 280, gapHours: [4, 40] },
			{ ...ender, materials: ['PLA', 'PETG'], spools: { PLA: 3, PETG: 6 }, watts: 150, gapHours: [8, 60], days: 260 },
			// Retired before the Ender came along.
			{ id: 'retired-cr10', name: 'CR-10 (retired)', materials: ['PLA'], spools: {}, watts: 200, gapHours: [6, 30], days: 425, until: now - 270 * 86_400_000 }
		],
		now
	);
	seed(join(dataDir, 'octo-modern.db'), rows, now);
	log(`  ${rows.length} prints`);

	// --- API -----------------------------------------------------------------------------------------
	const finished = (list) => list.filter((r) => ['success', 'failed', 'cancelled'].includes(r.result));
	const since = (ms) => rows.filter((r) => Date.parse(r.startedAt) >= ms);
	const all = (await admin.get('/api/stats?range=all&tz=Europe/Berlin')).data;
	assert.equal(all.totals.prints, finished(rows).length, 'all time: every seeded print');
	assert.equal(all.granularity, 'month');
	assert.deepEqual(
		all.printers.map((p) => [p.name, p.removed]),
		[
			['Prusa MK4', false],
			['Voron 2.4', false],
			['Ender 3 S1', false],
			['CR-10 (retired)', true]
		]
	);
	const r30 = (await admin.get('/api/stats?range=30d&tz=Europe/Berlin')).data;
	assert.equal(r30.buckets.length, 30);
	assert.equal(r30.totals.prints, since(Date.parse(r30.from)).length);
	assert.ok(r30.spools?.length, 'filament per spool');
	assert.ok(r30.spools.some((s) => s.name === 'Galaxy Black'), 'spool names from Spoolman');
	assert.ok(r30.totals.costed > 0);
	const r12 = (await admin.get('/api/stats?range=12m&tz=America/Los_Angeles')).data;
	assert.equal(r12.buckets.length, 12);
	assert.equal(r12.timeZone, 'America/Los_Angeles');
	const sum = r12.buckets.reduce((s, b) => s + b.success + b.failed + b.cancelled, 0);
	assert.equal(sum, r12.totals.prints, 'buckets add up to the totals');

	log('viewer: only their printer');
	const v = (await viewer.get('/api/stats?range=all')).data;
	assert.deepEqual(v.printers.map((p) => p.name), ['Prusa MK4']);
	assert.equal(v.totals.prints, finished(rows.filter((r) => r.printer.id === mk4.id)).length);
	assert.ok(v.buckets.every((b) => Object.keys(b.printTime).every((id) => id === mk4.id)));
	assert.equal((await viewer.get(`/api/stats?printer=${voron.id}`)).status, 404, 'another printer doesn’t exist for them');
	assert.equal((await viewer.get('/api/stats?printer=retired-cr10')).status, 404);
	const vcsv = await viewer.get(`/api/history/export.csv?from=${encodeURIComponent(v.from)}&to=${encodeURIComponent(v.to)}`);
	assert.equal(vcsv.status, 200);
	assert.ok(!vcsv.text.includes('Voron 2.4') && !vcsv.text.includes('CR-10'), 'the CSV has their printer only');
	assert.equal((await client().get('/api/stats')).status, 401, 'signed out: nothing');

	// --- browser -------------------------------------------------------------------------------------
	browser = await chromium.launch();
	const newPage = async (theme, width = 1440, height = 900) => {
		const mobile = width < 640 ? { hasTouch: true, isMobile: true } : {};
		const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: width < 640 ? 2 : 1, colorScheme: theme, timezoneId: 'Europe/Berlin', locale: 'en-GB', ...mobile });
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
	const ready = async (page) => {
		await page.waitForSelector('[data-testid=stats-tiles]');
		await page.waitForLoadState('networkidle');
		await sleep(300);
	};

	log('browser: admin, 12 months, dark and light');
	const dark = await newPage('dark');
	await signIn(dark, ADMIN);
	// Stats is a tab of History.
	await dark.goto(`${APP}/history`);
	await dark.click('[data-testid=segmented] a:has-text("Stats")');
	await dark.waitForURL(`${APP}/history/stats`);
	await ready(dark);
	assert.ok(await dark.locator('aside nav a[href="/history"][aria-current], aside nav a[href="/history"][class*="bg-accent"]').first().isVisible(), 'History is highlighted in the sidebar');
	assert.equal(await dark.locator('aside nav a[href="/stats"]').count(), 0, 'no separate Stats entry');
	await dark.click('role=radio[name="12 months"]');
	await dark.waitForURL((u) => u.searchParams.get('range') === '12m');
	await ready(dark);
	assert.equal(await dark.locator('[data-testid=stats-cost]').count(), 1, 'costs are set: the cost tile shows');
	// Hover a column for the tooltip in the screenshot.
	const chart = dark.locator('#chart-time ~ div svg');
	const box = await chart.boundingBox();
	await dark.mouse.move(box.x + box.width * 0.83, box.y + box.height * 0.6);
	await sleep(200);
	await shot(dark, 'stats');
	await dark.mouse.move(5, 5);
	await dark.evaluate(() => document.querySelector('main .overflow-y-auto, .h-full.overflow-y-auto')?.scrollTo(0, 99_999));
	await sleep(200);
	await shot(dark, 'stats-tables');

	// CSV of the range, through the page's own link.
	const href = await dark.locator('[data-testid=stats-csv]').getAttribute('href');
	const csv = await admin.get(href);
	assert.equal(csv.status, 200);
	assert.match(csv.headers.get('content-type'), /text\/csv/);
	const lines = csv.text.trim().split('\r\n');
	const q = new URL(href, APP).searchParams;
	const inRange = rows.filter((r) => r.startedAt >= q.get('from') && r.startedAt <= q.get('to'));
	assert.equal(lines.length - 1, inRange.length, 'one CSV row per print of the range');

	// A file links to its history.
	const first = dark.locator('section[aria-labelledby=files] tbody a').first();
	const fname = (await first.locator('span').first().textContent()).trim();
	await first.click();
	await dark.waitForURL((u) => u.pathname === '/history' && u.searchParams.get('q') === fname);
	await dark.waitForSelector(`text=${fname}`);
	assert.equal(await dark.inputValue('input[aria-label="Search history"]'), fname, 'the history opens filtered to the file');

	const light = await newPage('light');
	await signIn(light, ADMIN);
	// The old /stats links redirect, keeping the range.
	await light.goto(`${APP}/stats?range=90d`);
	await light.waitForURL(`${APP}/history/stats?range=90d`);
	await ready(light);
	await shot(light, 'stats-light');

	log('browser: one printer');
	await light.selectOption('select[aria-label=Printer]', voron.id);
	await light.waitForURL((u) => u.searchParams.get('printer') === voron.id);
	await ready(light);

	log('browser: phone');
	const phone = await newPage('dark', 390, 844);
	await signIn(phone, ADMIN);
	await phone.goto(`${APP}/history/stats?range=12m`);
	await ready(phone);
	const overflow = await phone.evaluate(() => {
		const el = document.querySelector('.h-full.overflow-y-auto');
		return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, el.scrollWidth - el.clientWidth);
	});
	if (overflow > 0) console.log(await phone.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map((e) => `${e.tagName}.${String(e.className?.baseVal ?? e.className).slice(0, 80)} ${Math.round(e.getBoundingClientRect().right)}`)));
	assert.ok(overflow <= 0, `no sideways scrolling on a phone (${overflow}px)`);
	// The charts, under the tiles.
	await phone.evaluate(() => document.querySelector('#chart-time')?.scrollIntoView({ block: 'start' }));
	await sleep(200);
	await shot(phone, 'mobile-stats');

	log('browser: viewer');
	const vpage = await newPage('dark');
	await signIn(vpage, VIEWER);
	await vpage.goto(`${APP}/history/stats?range=all`);
	await ready(vpage);
	assert.equal(await vpage.locator('select[aria-label=Printer]').count(), 0, 'one printer: no picker');
	assert.equal(await vpage.locator('text=Voron 2.4').count(), 0);

	for (const p of [dark, light, phone, vpage]) assert.deepEqual(p.errors, [], 'no browser errors');
	log('all stats e2e checks passed');
}

async function cleanup(ok) {
	stopping = true;
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
