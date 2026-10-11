// Phones: every main page at 360, 390 and 430 px wide (an iPhone-like touch screen) with no
// sideways scrolling, and the things a thumb needs (menu, job controls, jog pad, Print buttons,
// the terminal prompt) visible, at least 44 px and doing what they say.
//
//   pnpm e2e:mobile                   # build, run, check, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:mobile        # leave the containers and app running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:mobile  # reuse ./build
//
// Ports (override with the env vars): app 3180, OctoPrint 5161–5162, test camera 5261.
// Needs Docker and a Playwright Chromium. Screenshots (mobile-*.png) land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMjpegSource } from '../mjpeg-source.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3180);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_BASE = Number(process.env.E2E_OP_PORT_BASE ?? 5161);
const OP_PREFIX = process.env.E2E_OP_PREFIX ?? 'octo-modern-mobile-e2e-op';
const CAM_PORT = Number(process.env.E2E_CAM_PORT ?? 5261);
const CAM = `http://127.0.0.1:${CAM_PORT}`;
const OP = [1, 2].map((i) => ({ url: `http://127.0.0.1:${OP_BASE + i - 1}`, key: `ocm-dev-key-${i}` }));
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
/** The smallest touch target we accept (Apple's 44 pt). */
const TAP = 44;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const opEnv = { ...process.env, OCM_OP_PORT_BASE: String(OP_BASE), OCM_OP_PREFIX: OP_PREFIX };
const devOctoprint = (...args) => execFileSync(join(ROOT, 'scripts/dev-octoprint.sh'), args, { env: opEnv, stdio: 'inherit' });

let app;
let browser;
let cam;
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-mobile-'));
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

/** G-code that takes about `seconds` to print on the virtual printer. */
function timedGcode(seconds) {
	const lines = ['; octo-modern mobile e2e', 'G21', 'G90', 'M82', 'G28', 'G92 E0', 'G1 Z0.2 F600'];
	for (let i = 0; i < seconds; i++) {
		lines.push(`G1 X${20 + (i % 10) * 8} Y${20 + Math.floor(i / 10) * 8} E${(i + 1) * 40} F1800`);
		if (i % 3 === 0) lines.push(`G1 Z${(0.2 + i * 0.2).toFixed(2)} F600`);
		lines.push('G4 P1000');
	}
	return lines.join('\n') + '\n';
}

async function upload(o, name, content) {
	const fd = new FormData();
	fd.set('file', new Blob([content]), name);
	const res = await fetch(`${o.url}/api/files/local`, { method: 'POST', headers: { 'X-Api-Key': o.key }, body: fd });
	assert.equal(res.status, 201, `upload to OctoPrint: ${await res.text()}`);
}

/** Elements sticking out past the right (or left) edge, outside anything meant to scroll sideways. */
const overflowing = (page) =>
	page.evaluate(() => {
		const W = window.innerWidth;
		const out = [];
		if (document.documentElement.scrollWidth > W) out.push(`page is ${document.documentElement.scrollWidth}px wide`);
		const inScroller = (el) => {
			for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
				const ox = getComputedStyle(e).overflowX;
				if ((ox === 'auto' || ox === 'scroll') && e.getBoundingClientRect().right <= W + 1) return true;
			}
			return false;
		};
		for (const el of document.querySelectorAll('body *')) {
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height || el.closest('.pointer-events-none, dialog:not([open])')) continue;
			if (getComputedStyle(el).visibility === 'hidden') continue;
			if ((r.right > W + 1 || r.left < -1) && !inScroller(el)) out.push(`<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 50)}"> ${Math.round(r.left)}–${Math.round(r.right)} "${(el.textContent ?? '').trim().slice(0, 30)}"`);
		}
		return out.slice(0, 5);
	});

/** Visible text fields with a font smaller than 16 px (iOS zooms into those). */
const smallFields = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), select, textarea')]
			.filter((e) => e.getBoundingClientRect().width && parseFloat(getComputedStyle(e).fontSize) < 16)
			.map((e) => e.getAttribute('aria-label') ?? e.getAttribute('placeholder') ?? e.id ?? e.tagName)
	);

async function tappable(locator, label, min = TAP) {
	await locator.waitFor({ state: 'visible', timeout: 15_000 });
	// Sheets and the drawer slide in: measure once it has settled.
	let box = await locator.boundingBox();
	for (let i = 0; i < 20; i++) {
		await sleep(60);
		const next = await locator.boundingBox();
		if (next && box && next.x === box.x && next.y === box.y && next.width === box.width) break;
		box = next;
	}
	assert.ok(box, `${label}: on screen`);
	assert.ok(box.height >= min - 0.5 && box.width >= min - 0.5, `${label}: ${Math.round(box.width)}×${Math.round(box.height)} px, want ≥ ${min}`);
	const vp = locator.page().viewportSize();
	assert.ok(box.y >= 0 && box.y + box.height <= vp.height + 0.5 && box.x >= 0 && box.x + box.width <= vp.width + 0.5, `${label}: inside the viewport`);
	return box;
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting two OctoPrint servers with virtual printers');
	devOctoprint('up', '2');
	cam = await startMjpegSource({ port: CAM_PORT, host: '127.0.0.1' });

	if (!process.env.E2E_SKIP_BUILD) {
		log('building');
		execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'ignore' });
	}
	mkdirSync(join(libDir, 'Calibration'), { recursive: true });
	writeFileSync(join(libDir, 'Benchy_0.2mm_PLA_MK4_2h13m.gcode'), timedGcode(30));
	writeFileSync(join(libDir, 'Calibration', 'temp-tower-190-230.gcode'), timedGcode(20));

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
	const voron = (await admin.post('/api/printers', { name: 'Voron 2.4 350mm', baseUrl: OP[1].url, apiKey: OP[1].key, color: 'cyan', webcamUrl: `${CAM}/?action=stream` })).data;
	assert.equal((await admin.post('/api/library/sources', { name: 'NAS prints', kind: 'folder', config: { path: libDir } })).status, 201);
	await waitFor(async () => (await admin.get('/api/printers/status')).data.every((s) => s.state === 'operational'), 'both printers ready');
	for (const o of OP) {
		await upload(o, 'calibration-cube-20mm.gcode', timedGcode(10));
		await upload(o, 'a_really_long_filename_for_the_spool_holder_bracket_v3_final_FINAL.gcode', timedGcode(10));
	}
	// The MK4 prints for the rest of the run (an hour of G-code).
	await upload(OP[0], 'Benchy_0.2mm_PLA_MK4_2h13m.gcode', timedGcode(3600));
	await waitFor(async () => (await fetch(`${OP[0].url}/api/files/local/Benchy_0.2mm_PLA_MK4_2h13m.gcode`, { headers: { 'X-Api-Key': OP[0].key } }).then((r) => r.json())).gcodeAnalysis?.filament, 'analysis', { tries: 240 });
	assert.equal((await admin.post(`/api/printers/${mk4.id}/files/select`, { origin: 'local', path: 'Benchy_0.2mm_PLA_MK4_2h13m.gcode', print: true })).status, 200);
	await waitFor(async () => (await admin.get('/api/printers/status')).data.find((s) => s.id === mk4.id)?.state === 'printing', 'the MK4 printing');

	browser = await chromium.launch();
	const newPhone = async ({ width = 390, height = 844, theme = 'dark' } = {}) => {
		const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
		await ctx.addInitScript((t) => localStorage.setItem('ocm-theme', t), theme);
		const page = await ctx.newPage();
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
		page.errors = errors;
		await page.goto(`${APP}/login`);
		await page.fill('#email', ADMIN.email);
		await page.fill('#pw', ADMIN.password);
		await page.locator('form button').last().tap();
		await page.waitForURL((u) => !u.pathname.startsWith('/login'));
		return page;
	};
	const shot = async (page, name) => {
		await page.screenshot({ path: join(SHOTS, `${name}.png`) });
		log(`  screenshot ${name}.png`);
	};

	const P = (id, tab) => `/p/${id}${tab ? `?tab=${tab}` : ''}`;
	const pages = [
		['/', 'overview'],
		[P(mk4.id), 'dashboard'],
		[P(mk4.id, 'files'), 'files'],
		[P(mk4.id, 'control'), 'control'],
		[P(mk4.id, 'terminal'), 'terminal'],
		[P(mk4.id, 'webcam'), 'webcam'],
		[P(mk4.id, 'timelapse'), 'timelapse'],
		[P(mk4.id, 'history'), 'printer history'],
		[P(voron.id), 'idle printer'],
		['/library', 'library'],
		['/library/sources', 'library sources'],
		['/history', 'history'],
		['/stats', 'stats'],
		['/discover', 'discover'],
		['/users', 'users'],
		['/audit', 'audit'],
		['/integrations', 'integrations'],
		['/settings', 'settings'],
		['/account', 'account']
	];

	// --- every page, three widths: no sideways scrolling, no small text fields -----------------
	for (const width of [360, 390, 430]) {
		log(`${width} px: every page fits`);
		const page = await newPhone({ width });
		for (const [url, name] of pages) {
			await page.goto(`${APP}${url}`);
			await page.waitForLoadState('networkidle').catch(() => {});
			await sleep(700);
			assert.deepEqual(await overflowing(page), [], `${name} at ${width} px: nothing sticks out sideways`);
			if (width === 390) {
				assert.deepEqual(await smallFields(page), [], `${name}: text fields use 16 px text (no iOS zoom)`);
				await tappable(page.getByRole('button', { name: 'Open menu' }), `${name}: menu button`);
			}
		}
		assert.deepEqual(page.errors, [], 'no browser errors');
		await page.context().close();
	}

	const page = await newPhone();

	log('top bar and drawer');
	await page.goto(`${APP}${P(mk4.id)}`);
	await page.waitForSelector('[data-testid="job-bar"]');
	assert.equal(await page.getByTestId('topbar-title').textContent(), 'Prusa MK4', 'the top bar names the printer');
	assert.equal(await page.locator('aside').isVisible(), false, 'no sidebar on a phone');
	await tappable(page.getByRole('button', { name: 'Search and commands' }), 'search button');
	await page.getByRole('button', { name: 'Search and commands' }).tap();
	const palette = page.getByRole('dialog', { name: 'Command palette' });
	await palette.waitFor();
	await sleep(400); // the opening animation scales it
	assert.equal(Math.round((await palette.boundingBox()).width), 390, 'the command palette fills the width');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Open menu' }).tap();
	const drawer = page.getByTestId('drawer');
	await drawer.getByRole('link', { name: 'Library' }).waitFor();
	await tappable(drawer.getByRole('link', { name: 'Library' }), 'drawer link');
	await shot(page, 'mobile-drawer');
	await page.keyboard.press('Escape');
	await waitFor(async () => !(await drawer.evaluate((d) => d.open)), 'Esc closes the drawer');
	await page.getByRole('button', { name: 'Open menu' }).tap();
	await drawer.getByRole('link', { name: 'History' }).tap();
	await page.waitForURL(`${APP}/history`);
	await waitFor(async () => !(await drawer.evaluate((d) => d.open)), 'the drawer closes on navigation');
	assert.equal(await page.getByTestId('topbar-title').textContent(), 'History');

	log('printer page: job bar, tabs, emergency stop asks first');
	await page.goto(`${APP}${P(mk4.id)}`);
	const bar = page.getByTestId('job-bar');
	await tappable(bar.getByRole('button', { name: 'Pause' }), 'Pause');
	await tappable(bar.getByRole('button', { name: 'Cancel' }), 'Cancel');
	const estop = await tappable(bar.getByRole('button', { name: 'Emergency stop' }), 'Emergency stop');
	const cancel = await bar.getByRole('button', { name: 'Cancel' }).boundingBox();
	assert.ok(estop.x - (cancel.x + cancel.width) >= 8, 'emergency stop is set apart from Cancel');
	await sleep(1500);
	await shot(page, 'mobile-dashboard');
	await bar.getByRole('button', { name: 'Emergency stop' }).tap();
	const confirm = page.getByRole('dialog').filter({ hasText: 'Emergency stop Prusa MK4?' });
	await confirm.waitFor();
	await sleep(400);
	const sheet = await confirm.boundingBox();
	assert.ok(Math.abs(sheet.y + sheet.height - 844) < 2, 'dialogs are sheets along the bottom edge on phones');
	await shot(page, 'mobile-confirm');
	await confirm.getByRole('button', { name: 'Cancel' }).tap();
	await sleep(500);
	assert.equal((await admin.get('/api/printers/status')).data.find((s) => s.id === mk4.id).state, 'printing', 'still printing after backing out');
	const strip = page.getByRole('navigation', { name: 'Printer sections' });
	await strip.getByRole('button', { name: 'Timelapse' }).tap();
	await page.waitForURL(/tab=timelapse/);
	assert.ok(await strip.evaluate((n) => n.scrollWidth > n.clientWidth), 'the tab strip scrolls sideways');
	await tappable(strip.getByRole('button', { name: 'Timelapse' }), 'Timelapse tab');

	log('files: a list with Print at hand and a menu for the rest');
	await page.goto(`${APP}${P(voron.id, 'files')}`);
	const list = page.getByTestId('file-list');
	await list.waitFor();
	assert.equal(await page.locator('table').count(), 0, 'no table on a phone');
	await tappable(list.getByRole('button', { name: 'Print calibration-cube-20mm.gcode' }), 'Print');
	await tappable(page.getByRole('button', { name: 'Upload' }), 'Upload');
	const long = list.locator('[data-file^="a_really_long"]');
	assert.ok((await long.boundingBox()).height > 60, 'a long name wraps onto a second line instead of disappearing');
	await shot(page, 'mobile-files');
	await list.getByRole('button', { name: 'More actions: calibration-cube-20mm.gcode' }).tap();
	const menu = page.getByRole('dialog').filter({ has: page.getByRole('menuitem', { name: 'Load without printing' }) });
	await menu.waitFor();
	await tappable(menu.getByRole('menuitem', { name: /Delete file/ }), 'Delete in the menu');
	await page.keyboard.press('Escape');

	log('control: thumb-sized jog pad, segmented step size');
	await page.goto(`${APP}${P(voron.id, 'control')}`);
	await page.getByTestId('jog-pad').waitFor();
	for (const name of ['Y+ (back)', 'X− (left)', 'Home X and Y', 'Z− (down)']) await tappable(page.getByRole('button', { name, exact: true }), name, 56);
	for (const name of ['0.1', '100']) await tappable(page.getByRole('radio', { name, exact: true }), `step ${name}`, 40);
	assert.equal(await page.getByText('Click here to use the keyboard').isVisible(), false, 'no keyboard hints on a touch screen');
	await shot(page, 'mobile-control');

	log('terminal: fills the screen, prompt at the bottom');
	await page.goto(`${APP}${P(voron.id, 'terminal')}`);
	const input = page.getByTestId('terminal-input');
	const ib = await tappable(input, 'G-code prompt');
	assert.ok(ib.y > 844 - 200, 'the prompt sits at the bottom of the screen');
	assert.ok((await page.getByTestId('terminal-log').boundingBox()).height > 300, 'the log gets the rest of the height');
	await input.tap();
	await input.fill('M10');
	await page.getByTestId('gcode-suggestions').waitFor();
	assert.ok((await page.getByTestId('gcode-suggestions').boundingBox()).y < ib.y, 'suggestions open above the prompt');
	await page.getByRole('button', { name: 'Line filters' }).tap();
	await page.getByRole('dialog', { name: 'Line filters' }).waitFor();

	log('terminal while printing: the keyboard pushes the job bar aside, the prompt stays above it');
	await page.goto(`${APP}${P(mk4.id, 'terminal')}`);
	await page.getByTestId('job-bar').waitFor();
	await page.getByTestId('terminal-input').tap();
	// What Android does when the keyboard opens (interactive-widget=resizes-content); iOS shrinks only
	// the visual viewport, which takes the same path in trackVisualViewport.
	await page.setViewportSize({ width: 390, height: 480 });
	await waitFor(async () => (await page.evaluate(() => 'keyboard' in document.documentElement.dataset)) && !(await page.getByTestId('job-bar').isVisible()), 'the job bar stepping aside for the keyboard', { tries: 20, every: 200 });
	await tappable(page.getByTestId('terminal-input'), 'G-code prompt above the keyboard');
	await page.getByTestId('terminal-input').blur();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByTestId('job-bar').waitFor();

	log('history and library: lists and sheets');
	await page.goto(`${APP}/history`);
	await page.getByTestId('history-list').waitFor();
	await page.goto(`${APP}/library`);
	await page.locator('[data-entry="Benchy_0.2mm_PLA_MK4_2h13m.gcode"]').tap();
	const details = page.getByRole('dialog').filter({ has: page.getByTestId('library-details') });
	await details.waitFor();
	await tappable(details.getByRole('button', { name: 'Send & print' }), 'Send & print');
	await page.keyboard.press('Escape');

	log('light theme, the home-screen manifest');
	const light = await newPhone({ theme: 'light' });
	await light.goto(`${APP}${P(mk4.id)}`);
	await light.waitForSelector('[data-testid="job-bar"]');
	await sleep(1500);
	await shot(light, 'mobile-light');
	assert.equal(await light.locator('meta[name=theme-color]').getAttribute('content'), '#fbfaff', 'the status bar follows the light theme');
	assert.match(await light.locator('meta[name=viewport]').getAttribute('content'), /viewport-fit=cover/);
	const manifest = await (await fetch(new URL(await light.locator('link[rel=manifest]').getAttribute('href'), APP))).json();
	assert.equal(manifest.display, 'standalone');
	for (const icon of [...manifest.icons, { src: await light.locator('link[rel=apple-touch-icon]').getAttribute('href') }]) {
		const res = await fetch(new URL(icon.src, APP));
		assert.equal(res.headers.get('content-type'), 'image/png', `${icon.src} is served`);
	}

	for (const p of [page, light]) assert.deepEqual(p.errors, [], 'no browser errors');
	log('all mobile e2e checks passed');
}

async function cleanup(ok) {
	await browser?.close().catch(() => {});
	await cam?.close().catch(() => {});
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
