// End-to-end test of "Install app" (the sidebar entry, the drawer, the My account card and the
// iPhone sheet), against two local mock OctoPrint servers. Chromium's own install prompt can't
// be driven by automation, so `beforeinstallprompt` is dispatched by the test as a synthetic
// event with `prompt()` and `userChoice`, like Chromium's; standalone mode is emulated through
// matchMedia (`display-mode: standalone`) and on iOS with `navigator.standalone`.
//
//   pnpm e2e:install                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:install        # leave the app and mocks running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:install  # reuse ./build
//
// Ports 5800–5802 (E2E_PORT_BASE moves them): app 5800, OctoPrint 5801–5802. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMockOctoPrint } from './mock-octoprint.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const PORT_BASE = Number(process.env.E2E_PORT_BASE ?? 5800);
const APP_PORT = PORT_BASE;
const APP = `http://127.0.0.1:${APP_PORT}`;
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

let app;
let browser;
const closers = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-install-'));

async function waitFor(fn, label, { tries = 120, every = 250 } = {}) {
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

async function api(method, path, body, cookie) {
	const res = await fetch(`${APP}${path}`, {
		method,
		redirect: 'manual',
		headers: { 'content-type': 'application/json', origin: APP, ...(cookie ? { cookie } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], data: await res.json().catch(() => null) };
}

/** In the page: fire a Chromium-like `beforeinstallprompt`; its prompt() calls are counted. */
function fireInstallPrompt(outcome) {
	const e = new Event('beforeinstallprompt', { cancelable: true });
	e.prompt = async () => {
		window.__prompted = (window.__prompted ?? 0) + 1;
	};
	e.userChoice = Promise.resolve({ outcome, platform: 'web' });
	dispatchEvent(e);
	return e.defaultPrevented;
}

/** Init script: fire the event as soon as the document is parsed, before the app has started. */
function fireEarly(outcome) {
	document.addEventListener('readystatechange', () => {
		if (document.readyState !== 'interactive') return;
		const e = new Event('beforeinstallprompt', { cancelable: true });
		e.prompt = async () => {
			window.__prompted = (window.__prompted ?? 0) + 1;
		};
		e.userChoice = Promise.resolve({ outcome, platform: 'web' });
		dispatchEvent(e);
	});
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting two mock OctoPrint servers');
	const mk4Op = await startMockOctoPrint({ port: PORT_BASE + 1, apiKey: 'mk4-e2e-key', printSeconds: 600 });
	const voronOp = await startMockOctoPrint({ port: PORT_BASE + 2, apiKey: 'voron-e2e-key', printSeconds: 600 });
	closers.push(mk4Op.close, voronOp.close);
	for (const [op, key] of [
		[mk4Op, 'mk4-e2e-key'],
		[voronOp, 'voron-e2e-key']
	])
		await fetch(`${op.url}/api/connection`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ command: 'connect' }) });

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
	process.on('exit', () => {
		try {
			writeFileSync(join(dataDir, 'app.log'), appLog);
		} catch {}
	});
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');

	const login = await api('POST', '/api/auth/login', ADMIN);
	assert.equal(login.status, 200);
	const cookie = login.cookie;
	assert.equal((await api('POST', '/api/printers', { name: 'Prusa MK4', baseUrl: mk4Op.url, apiKey: 'mk4-e2e-key', color: 'violet' }, cookie)).status, 201);
	assert.equal((await api('POST', '/api/printers', { name: 'Voron 2.4', baseUrl: voronOp.url, apiKey: 'voron-e2e-key', color: 'cyan' }, cookie)).status, 201);
	await fetch(`${mk4Op.url}/__mock/print?file=benchy.gcode`);

	browser = await chromium.launch();
	const pages = [];
	/** A signed-in page in a fresh browser profile. */
	const newPage = async (theme, { width = 1280, height = 860, userAgent, init = [] } = {}) => {
		const phone = width < 640;
		const ctx = await browser.newContext({
			viewport: { width, height },
			deviceScaleFactor: phone ? 2 : 1,
			colorScheme: theme,
			...(phone ? { hasTouch: true, isMobile: true, userAgent: userAgent ?? ANDROID } : userAgent ? { userAgent } : {})
		});
		await ctx.addInitScript((t) => localStorage.setItem('ocm-theme', t), theme);
		for (const [fn, arg] of init) await ctx.addInitScript(fn, arg);
		const page = await ctx.newPage();
		page.errors = [];
		page.on('pageerror', (e) => page.errors.push(String(e)));
		page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
		await page.goto(`${APP}/login`);
		await page.waitForLoadState('networkidle');
		await page.fill('#email', ADMIN.email);
		await page.fill('#pw', ADMIN.password);
		await page.click('button:has-text("Sign in")');
		await page.waitForURL((u) => !u.pathname.startsWith('/login'));
		await page.waitForLoadState('networkidle');
		pages.push(page);
		return page;
	};
	const shot = async (page, name, opts = {}) => {
		await page.waitForTimeout(350);
		await page.screenshot({ path: join(SHOTS, `${name}.png`), ...opts });
		log(`  screenshot ${name}.png`);
	};
	const visible = (page, sel) => page.locator(sel).first().isVisible();

	// --- a browser without either: nothing ---------------------------------------------------
	log('no install prompt and not iOS: nothing is offered');
	const plain = await newPage('light');
	await plain.waitForSelector('aside nav');
	await plain.waitForTimeout(500);
	assert.equal(await plain.locator('[data-testid=install-entry]').count(), 0);
	await plain.goto(`${APP}/account`);
	await plain.waitForSelector('[data-testid=push-devices]');
	assert.equal(await plain.locator('[data-testid=install-card]').count(), 0);

	// --- Chromium: beforeinstallprompt -------------------------------------------------------
	log('Chromium: a prompt fired before the app started is kept and offered');
	const light = await newPage('light', { init: [[fireEarly, 'accepted']] });
	await light.waitForSelector('aside [data-testid=install-button]');
	assert.equal(await light.evaluate(() => !!window.__ocmInstall), true, 'app.html stashed the early event');
	await shot(light, 'install-button');
	await light.goto(`${APP}/account`);
	await light.waitForSelector('[data-testid=install-card]');
	assert.match(await light.textContent('[data-testid=install-card-button]'), /Install app/);
	await shot(light, 'install-button-account');

	log('Chromium: clicking calls prompt(); accepted, the entry goes');
	await light.click('aside [data-testid=install-button]');
	await waitFor(() => light.evaluate(() => window.__prompted === 1), 'prompt()');
	await waitFor(async () => (await light.locator('[data-testid=install-entry]').count()) === 0, 'the entry hiding');
	assert.equal(await light.locator('[data-testid=install-card]').count(), 0);

	log('Chromium: a prompt fired later (after hydration) is used; appinstalled hides everything');
	assert.equal(await light.evaluate(fireInstallPrompt, 'dismissed'), true, 'the app calls preventDefault()');
	await light.waitForSelector('[data-testid=install-card]');
	await light.click('[data-testid=install-card-button]');
	await waitFor(() => light.evaluate(() => window.__prompted === 2), 'prompt() again');
	await light.evaluate(fireInstallPrompt, 'dismissed');
	await light.waitForSelector('aside [data-testid=install-button]');
	await light.evaluate(() => dispatchEvent(new Event('appinstalled')));
	await waitFor(async () => (await light.locator('[data-testid=install-card], [data-testid=install-entry]').count()) === 0, 'everything hiding after appinstalled');

	log('dark theme; the collapsed sidebar shows an icon');
	const dark = await newPage('dark', { init: [[fireEarly, 'accepted']] });
	await dark.waitForSelector('aside [data-testid=install-button]');
	await shot(dark, 'install-button-dark');
	await dark.goto(`${APP}/account`);
	await dark.waitForSelector('[data-testid=install-card]');
	await shot(dark, 'install-button-account-dark');
	await dark.keyboard.press('Control+b');
	await waitFor(async () => !(await dark.locator('aside [data-testid=install-button] span').count()), 'the rail');
	assert.ok(await visible(dark, 'aside [data-testid=install-button]'));
	await dark.keyboard.press('Control+b');

	log('"Not now" is remembered in this browser; My account still offers it');
	await dark.click('aside [data-testid=install-dismiss]');
	await waitFor(async () => (await dark.locator('[data-testid=install-entry]').count()) === 0, 'the entry hiding');
	assert.equal(await dark.evaluate(() => localStorage.getItem('ocm-install-dismissed')), '1');
	await dark.reload();
	await dark.waitForSelector('[data-testid=install-card]');
	assert.equal(await dark.locator('[data-testid=install-entry]').count(), 0);
	// Storage that throws (blocked site data) doesn't break anything.
	const blocked = await newPage('dark', {
		init: [
			[fireEarly, 'accepted'],
			[
				() => {
					Storage.prototype.setItem = () => {
						throw new DOMException('blocked', 'SecurityError');
					};
				}
			]
		]
	});
	await blocked.waitForSelector('aside [data-testid=install-dismiss]');
	await blocked.click('aside [data-testid=install-dismiss]');
	await waitFor(async () => (await blocked.locator('[data-testid=install-entry]').count()) === 0, 'the entry hiding without storage');

	log('already installed (display-mode: standalone): nothing is offered');
	// Chromium's DevTools protocol doesn't emulate display-mode (Emulation.setEmulatedMedia
	// ignores it), so matchMedia answers as an installed app's would.
	const standalone = await newPage('light', {
		init: [
			[fireEarly, 'accepted'],
			[
				() => {
					const real = window.matchMedia.bind(window);
					window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? real('all') : real(q));
				}
			]
		]
	});
	await standalone.waitForSelector('aside nav');
	assert.equal(await standalone.evaluate(() => matchMedia('(display-mode: standalone)').matches), true, 'standalone emulated');
	await standalone.waitForTimeout(500);
	assert.equal(await standalone.locator('[data-testid=install-entry]').count(), 0);
	await standalone.goto(`${APP}/account`);
	await standalone.waitForSelector('[data-testid=push-devices]');
	assert.equal(await standalone.locator('[data-testid=install-card]').count(), 0);

	// --- phones ------------------------------------------------------------------------------
	log('Android phone: the entry in the drawer');
	const android = await newPage('dark', { width: 390, height: 844, init: [[fireEarly, 'accepted']] });
	await android.click('button[aria-label="Open menu"]');
	await android.waitForSelector('[data-testid=drawer] [data-testid=install-button]');
	const tap = await android.locator('[data-testid=drawer] [data-testid=install-button]').boundingBox();
	assert.ok(tap.height >= 44, `a 44px tap target (${tap.height})`);
	await shot(android, 'install-button-mobile');
	await android.click('[data-testid=drawer] [data-testid=install-button]');
	await waitFor(() => android.evaluate(() => window.__prompted === 1), 'prompt() on the phone');

	log('iPhone Safari: the Share → Add to Home Screen sheet');
	const iphone = await newPage('light', { width: 390, height: 844, userAgent: IPHONE });
	await iphone.goto(`${APP}/account`);
	await iphone.waitForSelector('[data-testid=install-card]');
	assert.match(await iphone.textContent('[data-testid=install-card-button]'), /How to install/);
	await iphone.click('[data-testid=install-card-button]');
	await iphone.waitForSelector('[data-testid=install-ios-steps]');
	assert.match(await iphone.textContent('[data-testid=install-ios-steps]'), /Add to Home Screen/);
	await shot(iphone, 'install-button-ios');
	const iphoneDark = await newPage('dark', { width: 390, height: 844, userAgent: IPHONE });
	await iphoneDark.click('button[aria-label="Open menu"]');
	await iphoneDark.click('[data-testid=drawer] [data-testid=install-button]');
	await iphoneDark.waitForSelector('[data-testid=install-ios-steps]');
	await shot(iphoneDark, 'install-button-ios-dark');
	await iphoneDark.click('[data-testid=install-not-now]');
	await waitFor(async () => !(await iphoneDark.locator('[data-testid=install-ios-steps]').count()), 'the sheet closing');
	await iphoneDark.reload();
	await iphoneDark.click('button[aria-label="Open menu"]');
	await iphoneDark.waitForSelector('[data-testid=drawer] nav');
	assert.equal(await iphoneDark.locator('[data-testid=install-entry]').count(), 0, '"Not now" remembered');

	log('iPhone home-screen app (navigator.standalone): nothing is offered');
	const iosApp = await newPage('light', { width: 390, height: 844, userAgent: IPHONE, init: [[() => Object.defineProperty(navigator, 'standalone', { get: () => true })]] });
	await iosApp.goto(`${APP}/account`);
	await iosApp.waitForSelector('[data-testid=push-devices]');
	await iosApp.waitForTimeout(400);
	assert.equal(await iosApp.locator('[data-testid=install-card]').count(), 0);
	const overflow = await iphone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	assert.ok(overflow <= 0, `nothing sticks out sideways (${overflow}px)`);

	for (const p of pages) assert.deepEqual(p.errors, [], 'no errors in the browser console');
	log('all install checks passed');
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
