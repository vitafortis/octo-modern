// End-to-end test of the installable app and browser push, against local mocks only: two
// mock OctoPrint servers and a mock Web Push service (scripts/e2e/mock-push.mjs) that checks
// the VAPID signature and decrypts every message. No real push service is contacted:
// Chromium's own PushManager would register with Google's, so the browser's
// `pushManager.subscribe()` is replaced by one that returns a subscription at the mock; the
// rest (permission, the service worker, the server, encryption) is the real thing. Pushes
// are handed to the real service worker over the DevTools protocol.
//
//   pnpm e2e:push                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:push        # leave the app and mocks running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:push  # reuse ./build
//
// Ports 5200–5203: app 5200, OctoPrint 5201–5202, push service 5203.
// Needs a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMockOctoPrint } from './mock-octoprint.mjs';
import { startMockPush } from './mock-push.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = 5200;
const APP = `http://127.0.0.1:${APP_PORT}`;
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

let app;
let browser;
const closers = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-push-'));

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

function client() {
	let cookie = '';
	const call = async (method, path, body) => {
		const res = await fetch(`${APP}${path}`, {
			method,
			redirect: 'manual',
			headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), origin: APP, 'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' },
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
	return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p, {}) };
}

/**
 * Replaces PushManager in the page with one that hands out `sub` (a subscription at the mock
 * push service). Like a browser's, the subscription outlives the page (kept in localStorage).
 */
function fakePushManager(sub) {
	const KEY = 'e2e-push-sub';
	const make = (key) => ({
		endpoint: sub.endpoint,
		expirationTime: null,
		options: { userVisibleOnly: true, applicationServerKey: key },
		getKey: () => null,
		toJSON: () => sub,
		unsubscribe: async () => (localStorage.removeItem(KEY), true)
	});
	const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
	const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
	PushManager.prototype.subscribe = async function (opts) {
		const k = opts.applicationServerKey;
		const key = k instanceof ArrayBuffer ? k : k.buffer.slice(k.byteOffset, k.byteOffset + k.byteLength);
		localStorage.setItem(KEY, toB64(key));
		return make(key);
	};
	PushManager.prototype.getSubscription = async () => {
		const k = localStorage.getItem(KEY);
		return k ? make(fromB64(k)) : null;
	};
	PushManager.prototype.permissionState = async () => 'granted';
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting the mock push service and two mock OctoPrint servers');
	const push = await startMockPush(5203);
	const mk4Op = await startMockOctoPrint({ port: 5201, apiKey: 'mk4-e2e-key', printSeconds: 30 });
	const voronOp = await startMockOctoPrint({ port: 5202, apiKey: 'voron-e2e-key', printSeconds: 30 });
	closers.push(push.close, mk4Op.close, voronOp.close);
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
			// The mock push service, besides the browsers' real ones (which nothing here reaches).
			OCM_PUSH_ENDPOINTS: `${push.url}/push/`,
			VAPID_SUBJECT: 'mailto:admin@example.com',
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

	// --- installable app: served without signing in ---------------------------------------------
	log('manifest, icons, service worker and offline page are public');
	const anon = client();
	let r = await anon.get('/manifest.webmanifest');
	assert.equal(r.status, 200);
	const manifest = r.data;
	assert.equal(manifest.name, 'octo·modern');
	assert.equal(manifest.display, 'standalone');
	assert.ok(manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
	for (const p of [...manifest.icons.map((i) => i.src), '/apple-touch-icon.png', '/badge-96.png']) {
		const res = await fetch(`${APP}${p}`);
		assert.equal(res.status, 200, p);
		assert.equal(res.headers.get('content-type'), 'image/png', p);
	}
	r = await anon.get('/service-worker.js');
	assert.equal(r.status, 200);
	assert.match(r.headers.get('content-type'), /javascript/);
	assert.match(r.text, /ocm-shell-/);
	r = await anon.get('/offline.html');
	assert.equal(r.status, 200);
	assert.match(r.text, /out of reach/);
	assert.equal((await anon.get('/api/push')).status, 401);

	// --- people and printers --------------------------------------------------------------------
	const admin = client();
	assert.equal((await admin.post('/api/auth/login', ADMIN)).status, 200);
	const mk4 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: mk4Op.url, apiKey: 'mk4-e2e-key', color: 'violet' })).data;
	const voron = (await admin.post('/api/printers', { name: 'Voron 2.4', baseUrl: voronOp.url, apiKey: 'voron-e2e-key', color: 'cyan' })).data;
	const ids = {};
	for (const u of [
		{ ...OPERATOR, role: 'operator' },
		{ ...VIEWER, role: 'viewer' }
	]) {
		r = await admin.post('/api/users', u);
		assert.equal(r.status, 201, r.text);
		ids[u.email] = r.data.id ?? r.data.user?.id;
	}
	// The viewer only sees the MK4.
	assert.equal((await admin.put(`/api/users/${ids[VIEWER.email]}/access`, { printerAccess: 'selected', printers: [mk4.id] })).status, 200);
	const operator = client();
	const viewer = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);

	// --- the server side of subscribing --------------------------------------------------------
	log('subscriptions: validation, ownership, counts');
	r = await viewer.get('/api/push');
	assert.equal(r.status, 200);
	assert.match(r.data.publicKey, /^B[-_A-Za-z0-9]{86}$/);
	assert.deepEqual(r.data.devices, []);
	assert.equal(r.data.counts, undefined, 'only admins see counts');
	assert.equal(r.data.channelReady, false);
	const publicKey = r.data.publicKey;
	r = await viewer.post('/api/push/subscriptions', { subscription: { endpoint: 'https://evil.example/push', keys: push.newSubscription('x').keys } });
	assert.equal(r.status, 400);
	assert.match(r.data.message, /isn’t one octo·modern sends to/);
	r = await viewer.post('/api/push/subscriptions', { subscription: push.newSubscription('vera-phone') });
	assert.equal(r.status, 201, r.text);
	assert.equal(r.data.device.label, 'Chrome on Android');
	const veraDevice = r.data.device.id;
	r = await operator.post('/api/push/subscriptions', { subscription: push.newSubscription('otto-phone') });
	assert.equal(r.status, 201);
	const ottoDevice = r.data.device.id;
	r = await operator.post('/api/push/subscriptions', { subscription: push.newSubscription('gone-otto-tablet') });
	const goneDevice = r.data.device.id;
	// Nobody removes or tests someone else's device.
	assert.equal((await operator.del(`/api/push/subscriptions/${veraDevice}`)).status, 404);
	assert.equal((await admin.del(`/api/push/subscriptions/${veraDevice}`)).status, 404);
	assert.equal((await operator.post(`/api/push/subscriptions/${veraDevice}/test`)).status, 404);
	assert.equal((await viewer.get('/api/push')).data.devices.length, 1);
	r = await admin.get('/api/push');
	assert.deepEqual(r.data.counts, { devices: 3, users: 2 });
	// A test to one's own device: decrypted by the mock, signed with the server's key.
	r = await viewer.post(`/api/push/subscriptions/${veraDevice}/test`);
	assert.equal(r.status, 200, r.text);
	const [veraTest] = push.payloadsFor('vera-phone');
	assert.equal(veraTest.title, 'Test from octo·modern');
	assert.equal(veraTest.body, 'Notifications reach Chrome on Android.');
	const req = push.received.find((x) => x.name === 'vera-phone');
	assert.equal(req.vapid.publicKey, publicKey);
	assert.equal(req.vapid.claims.sub, 'mailto:admin@example.com');
	// A device the push service says is gone is removed on the first send.
	r = await operator.post(`/api/push/subscriptions/${goneDevice}/test`);
	assert.equal(r.status, 502);
	assert.equal(r.data.gone, true);
	assert.deepEqual((await operator.get('/api/push')).data.devices.map((d) => d.id), [ottoDevice]);

	// --- a Browser push channel and a rule -------------------------------------------------------
	log('a Browser push channel; prints reach the people who can see the printer');
	r = await admin.post('/api/settings/notifications/channels', { type: 'push', name: 'Phones', config: { audience: 'all' } });
	assert.equal(r.status, 201, r.text);
	const channel = r.data.channel;
	assert.equal((await operator.post('/api/settings/notifications/channels', { type: 'push', name: 'x' })).status, 403);
	r = await admin.put('/api/settings/notifications', { rules: [{ name: 'Prints to phones', printers: 'all', events: ['print.started', 'print.finished'], channels: [channel.id] }] });
	assert.equal(r.status, 200, r.text);
	assert.equal((await viewer.get('/api/push')).data.channelReady, true);

	push.reset();
	await fetch(`${voronOp.url}/__mock/print?file=voron-cube.gcode`);
	await waitFor(() => push.payloadsFor('otto-phone').some((p) => p.kind === 'print.started'), 'print.started on the operator’s phone');
	const started = push.payloadsFor('otto-phone').find((p) => p.kind === 'print.started');
	assert.equal(started.title, 'Print started: voron-cube.gcode');
	assert.equal(started.url, `/p/${voron.id}`);
	assert.equal(started.tag, `ocm:${voron.id}:print`);
	await sleep(1500);
	assert.equal(push.payloadsFor('vera-phone').length, 0, 'the viewer can’t see the Voron');
	await fetch(`${mk4Op.url}/__mock/print?file=benchy.gcode`);
	await waitFor(() => push.payloadsFor('vera-phone').some((p) => p.kind === 'print.started' && p.printerId === mk4.id), 'print.started on the viewer’s phone');

	// --- the browser: service worker, enabling on this device, a push shown ---------------------
	// The full Chromium build (new headless): the headless shell always denies notifications.
	browser = await chromium.launch({ channel: 'chromium' });
	const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
	const newPage = async (theme, { width = 1280, height = 900, sub } = {}) => {
		const mobile = width < 640 ? { hasTouch: true, isMobile: true, userAgent: ANDROID } : {};
		const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: width < 640 ? 2 : 1, colorScheme: theme, ...mobile });
		await ctx.grantPermissions(['notifications'], { origin: APP });
		await ctx.addInitScript((t) => localStorage.setItem('ocm-theme', t), theme);
		if (sub) await ctx.addInitScript(fakePushManager, sub);
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
	const shot = async (target, name) => {
		const pg = 'page' in target ? target.page() : target;
		for (const b of await pg.$$('button[aria-label=Dismiss]')) await b.click().catch(() => {});
		await pg.waitForTimeout(300);
		await target.screenshot({ path: join(SHOTS, `${name}.png`) });
		log(`  screenshot ${name}.png`);
	};

	log('browser: the service worker registers and caches only the app shell');
	const adaSub = push.newSubscription('ada-laptop');
	const page = await newPage('light', { sub: adaSub });
	await signIn(page, ADMIN);
	await page.goto(`${APP}/account`);
	const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
	assert.equal(scope, `${APP}/`);
	await page.reload();
	await waitFor(() => page.evaluate(() => !!navigator.serviceWorker.controller), 'the service worker controlling the page');
	const cached = await page.evaluate(async () => {
		const out = [];
		for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
		return out;
	});
	assert.ok(cached.includes('/offline.html') && cached.includes('/manifest.webmanifest'));
	assert.ok(cached.some((p) => p.startsWith('/_app/immutable/')));
	assert.deepEqual(
		cached.filter((p) => !p.startsWith('/_app/immutable/') && !/^\/[\w.-]+\.(png|webmanifest|html|txt)$/.test(p)),
		[],
		'nothing but build output and static files is cached'
	);
	assert.ok(!cached.some((p) => p.startsWith('/api/') || p === '/' || p === '/account' || p === '/login'));

	log('browser: enable notifications on this device, send a test');
	await page.waitForSelector('[data-testid=push-on]', { timeout: 8000 }).catch(async (e) => {
		console.log(await page.textContent('[data-testid=push-devices]'), page.errors, await page.evaluate(() => ({ sec: isSecureContext, pm: 'PushManager' in window, n: 'Notification' in window, perm: Notification.permission })));
		throw e;
	});
	await page.click('[data-testid=push-on]');
	await page.waitForSelector('[data-testid=push-this-device]');
	r = await admin.get('/api/push');
	assert.equal(r.data.devices.length, 1);
	assert.equal(r.data.devices[0].endpoint, adaSub.endpoint);
	push.reset();
	await page.click('[data-device] button:has-text("Send test")');
	await waitFor(() => push.payloadsFor('ada-laptop').length, 'the test at the push service');
	await page.waitForSelector('text=Test sent to');

	log('browser: a push message reaches the service worker and shows a notification');
	const cdp = await page.context().newCDPSession(page);
	const regs = [];
	cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
	await cdp.send('ServiceWorker.enable');
	const reg = await waitFor(() => regs.find((x) => x.scopeURL === `${APP}/` && !x.isDeleted), 'the service worker registration');
	await fetch(`${mk4Op.url}/__mock/print?file=gearbox-housing.gcode`).catch(() => {});
	const payload = await waitFor(() => push.payloadsFor('ada-laptop').find((p) => p.kind === 'print.started' && p.title.includes('gearbox')), 'print.started on Ada’s laptop', { tries: 200 });
	await cdp.send('ServiceWorker.deliverPushMessage', { origin: APP, registrationId: reg.registrationId, data: JSON.stringify(payload) });
	const shown = await waitFor(
		() =>
			page.evaluate(async () => {
				const list = await (await navigator.serviceWorker.ready).getNotifications();
				return list.map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data, icon: n.icon, badge: n.badge }));
			}).then((l) => l.find((n) => n.title.includes('gearbox'))),
		'the notification'
	);
	assert.equal(shown.title, 'Print started: gearbox-housing.gcode');
	assert.equal(shown.tag, `ocm:${mk4.id}:print`);
	assert.equal(shown.data.url, `/p/${mk4.id}`);
	assert.match(shown.icon, /\/icon-192\.png$/);
	assert.match(shown.badge, /\/badge-96\.png$/);

	log('screenshots: My account and Notifications, light and dark');
	await page.goto(`${APP}/account`);
	await page.waitForSelector('[data-testid=push-this-device]');
	await shot(page, 'push-account');
	await page.goto(`${APP}/notifications`);
	await page.waitForSelector('[data-testid=push-this-device]');
	await page.waitForSelector('[data-channel="Phones"]');
	await shot(page.locator('[data-testid=push-devices]'), 'push-notifications-devices');
	const dark = await newPage('dark', { sub: adaSub });
	await signIn(dark, ADMIN);
	await dark.goto(`${APP}/account`);
	await dark.waitForSelector('[data-testid=push-on], [data-testid=push-this-device]');
	// A new browser profile: subscribing again takes over the same endpoint.
	if (await dark.$('[data-testid=push-on]')) {
		await dark.click('[data-testid=push-on]');
		await dark.waitForSelector('[data-testid=push-this-device]');
		await dark.waitForTimeout(400);
	}
	await dark.goto(`${APP}/account`);
	await dark.waitForSelector('[data-testid=push-this-device]');
	await shot(dark, 'push-account-dark');
	await dark.goto(`${APP}/notifications`);
	await dark.waitForSelector('[data-testid=push-this-device]');
	await shot(dark.locator('[data-testid=push-devices]'), 'push-notifications-devices-dark');

	log('phone: the device list and the iPhone hint');
	const phone = await newPage('dark', { width: 390, height: 844, sub: push.newSubscription('vera-iphone') });
	await signIn(phone, VIEWER);
	await phone.goto(`${APP}/account`);
	await phone.waitForSelector('[data-testid=push-on]');
	await phone.click('[data-testid=push-on]');
	await phone.waitForSelector('[data-testid=push-this-device]');
	assert.ok(await phone.$('[data-testid=push-not-ready]') === null, 'the channel is set up');
	const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	assert.ok(overflow <= 0, `nothing sticks out sideways (${overflow}px)`);
	await phone.evaluate(() => document.querySelector('[data-testid=push-devices]').scrollIntoView({ block: 'center' }));
	await shot(phone, 'mobile-push');
	// An iPhone browser tab (not added to the Home Screen) is told what to do.
	const ios = await browser.newContext({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
	});
	const iosPage = await ios.newPage();
	await signIn(iosPage, VIEWER);
	await iosPage.goto(`${APP}/account`);
	await iosPage.waitForSelector('[data-testid=push-unsupported]:has-text("Add to Home Screen")');
	assert.equal(await iosPage.$('[data-testid=push-on]'), null);
	await ios.close();

	log('offline: pages fall back to the offline page, APIs are never answered from cache');
	await page.goto(`${APP}/`);
	await page.context().setOffline(true);
	await page.goto(`${APP}/history`).catch(() => {});
	await page.waitForSelector('[data-testid=offline]');
	assert.match(await page.textContent('h1'), /out of reach/);
	const apiOffline = await page.evaluate(async () => {
		try {
			await fetch('/api/push');
			return 'answered';
		} catch {
			return 'failed';
		}
	});
	assert.equal(apiOffline, 'failed', 'API calls go to the network only');
	await shot(page, 'push-offline');
	await page.context().setOffline(false);
	await page.goto(`${APP}/account`);
	await page.waitForSelector('[data-testid=push-devices]');

	log('turning it off on this device removes it on the server');
	await page.waitForSelector('[data-testid=push-off]');
	await page.click('[data-testid=push-off]');
	await page.waitForSelector('[data-testid=push-on]');
	r = await admin.get('/api/push');
	assert.ok(!r.data.devices.some((d) => d.endpoint === adaSub.endpoint));

	// The audit log has who turned what on and off.
	r = await admin.get('/api/audit?action=push.');
	const actions = (r.data.items ?? r.data).map((e) => e.action);
	for (const a of ['push.subscribe', 'push.unsubscribe', 'push.test']) assert.ok(actions.includes(a), a);

	for (const p of [page, dark, phone]) assert.deepEqual(p.errors, [], 'no errors in the browser console');
	log('all browser push checks passed');
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
