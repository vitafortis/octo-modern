// End-to-end test of notifications against a real OctoPrint (virtual printer in Docker)
// and local stand-ins for every service (scripts/e2e/mock-notify.mjs): nothing real is
// contacted.
//
//   pnpm e2e:notify                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:notify        # leave the container and app running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:notify  # reuse ./build
//
// Ports (override with the env vars): app 3200, OctoPrint 3201, test camera 3202, mock
// services 3204 (HTTP) and 3205 (SMTP with STARTTLS). Needs Docker and a Playwright
// Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMjpegSource } from '../mjpeg-source.mjs';
import { startMockNotify, startMockSmtp } from './mock-notify.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3200);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_PORT = Number(process.env.E2E_OP_PORT_BASE ?? 3201);
const OP_PREFIX = process.env.E2E_OP_PREFIX ?? 'octo-modern-notify-op';
const CAM_PORT = Number(process.env.E2E_CAM_PORT ?? 3202);
const CAM = `http://127.0.0.1:${CAM_PORT}`;
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 3204);
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 3205);
const OP = { url: `http://127.0.0.1:${OP_PORT}`, key: 'ocm-dev-key-1' };
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const opEnv = { ...process.env, OCM_OP_PORT_BASE: String(OP_PORT), OCM_OP_PREFIX: OP_PREFIX };
const devOctoprint = (...args) => execFileSync(join(ROOT, 'scripts/dev-octoprint.sh'), args, { env: opEnv, stdio: 'inherit' });

let app;
let browser;
let cam;
let http;
let smtp;
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-notify-'));

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
		const type = res.headers.get('content-type') ?? '';
		const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
		return { status: res.status, data, headers: res.headers };
	};
	return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p, {}), get cookie() { return cookie; } };
}

/** G-code that takes about `seconds` on the virtual printer, heating the bed; `pauseAt` adds an M0 there. */
function timedGcode(seconds, { pauseAt = null } = {}) {
	const lines = ['; octo-modern notify e2e', 'G21', 'G90', 'M82', 'M140 S60', 'M104 S180', 'G28', 'G92 E0', 'G1 Z0.2 F600'];
	for (let i = 0; i < seconds; i++) {
		if (i === pauseAt) lines.push('M0 Pause for the e2e');
		lines.push(`G1 X${20 + (i % 10) * 8} Y${20 + Math.floor(i / 10) * 8} E${(i + 1) * 40} F1800`);
		lines.push('G4 P1000');
	}
	return lines.join('\n') + '\n';
}

async function op(method, path, body) {
	const res = await fetch(`${OP.url}${path}`, { method, headers: { 'X-Api-Key': OP.key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function upload(name, content) {
	const fd = new FormData();
	fd.set('file', new Blob([content]), name);
	const res = await fetch(`${OP.url}/api/files/local`, { method: 'POST', headers: { 'X-Api-Key': OP.key }, body: fd });
	assert.equal(res.status, 201, await res.text());
	await waitFor(async () => (await op('GET', `/api/files/local/${name}`)).gcodeAnalysis?.filament?.tool0?.length, `analysis of ${name}`);
}

const opState = async () => (await op('GET', '/api/job')).state;

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log(`mock services on :${MOCK_PORT} (HTTP) and :${SMTP_PORT} (SMTP)`);
	http = await startMockNotify(MOCK_PORT);
	smtp = await startMockSmtp(SMTP_PORT);
	const M = http.url;
	log('starting an OctoPrint server with a virtual printer');
	devOctoprint('up', '1');
	cam = await startMjpegSource({ port: CAM_PORT, host: '127.0.0.1' });

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
			OCM_PUSHOVER_API: `${M}/pushover/1/messages.json`,
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
	const printer = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: OP.url, apiKey: OP.key, color: 'violet', webcamUrl: `${CAM}/?action=stream` })).data;
	assert.equal((await admin.post('/api/users', { ...OPERATOR, role: 'operator' })).status, 201);
	const operator = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await operator.get('/api/settings/notifications')).status, 403, 'admins only');
	await waitFor(async () => (await admin.get('/api/printers/status')).data[0]?.state === 'operational', 'printer ready');

	// --- channels: one of every type, each against its mock ----------------------------------------
	log('channels: one of each type, Send test on each');
	const CHANNELS = [
		{ type: 'ntfy', name: 'Phone (ntfy)', config: { server: `${M}/ntfy`, topic: 'prints' }, secrets: { token: 'tk_e2e' } },
		{ type: 'discord', name: 'Discord #printing', secrets: { url: `${M}/discord/api/webhooks/1/abc` } },
		{ type: 'slack', name: 'Slack #lab', secrets: { url: `${M}/slack/services/T/B/x` } },
		{ type: 'telegram', name: 'Telegram family', config: { server: `${M}/telegram`, chatId: '-100123' }, secrets: { botToken: '123456:e2e-token' } },
		{ type: 'pushover', name: 'Pushover', config: {}, secrets: { appToken: 'a'.repeat(30), userKey: 'k'.repeat(30) } },
		{ type: 'gotify', name: 'Gotify', config: { server: `${M}/gotify` }, secrets: { appToken: 'gotify-e2e' } },
		{ type: 'matrix', name: 'Matrix room', config: { homeserver: `${M}/matrix`, roomId: '!lab:mock' }, secrets: { accessToken: 'mx-e2e' } },
		{
			type: 'email',
			name: 'Email',
			config: { host: '127.0.0.1', port: String(SMTP_PORT), security: 'starttls', username: 'octo', from: 'octo@example.com', to: 'me@example.com', allowSelfSigned: true },
			secrets: { password: 'secret' }
		},
		{ type: 'homeassistant', name: 'Home Assistant', config: { baseUrl: `${M}/ha`, service: 'mobile_app_phone' }, secrets: { webhookId: 'octo-e2e', token: 'ha-llt' } },
		{ type: 'webhook', name: 'Webhook', config: { format: '2', includeImage: true }, secrets: { url: `${M}/hook/print`, authorization: 'Bearer e2e' } }
	];
	const ids = {};
	for (const c of CHANNELS) {
		const r = await admin.post('/api/settings/notifications/channels', c);
		assert.equal(r.status, 201, `${c.type}: ${JSON.stringify(r.data)}`);
		ids[c.type] = r.data.channel.id;
		for (const v of Object.values(c.secrets)) assert.ok(!JSON.stringify(r.data).includes(JSON.stringify(v)), `${c.type}: secrets never come back`);
	}
	await admin.put('/api/settings/notifications', {
		publicUrl: APP,
		mediaLinks: true,
		progressPercents: [50],
		progressMinutesLeft: [],
		offlineGraceS: 5,
		hot: { minutes: 0.25, bedC: 30, hotendC: 400 }
	});
	for (const c of CHANNELS) {
		const r = await admin.post('/api/settings/notifications/test', { id: ids[c.type] });
		assert.equal(r.status, 200, `test ${c.type}: ${JSON.stringify(r.data)}`);
	}
	assert.equal(http.find('/telegram/bot123456:e2e-token/sendPhoto').length, 1, 'tests send a picture');
	assert.equal(smtp.messages.length, 1);
	// A failing test shows the service's exact answer.
	const bad = await admin.post('/api/settings/notifications/test', { id: ids.telegram, channel: { type: 'telegram', name: 'x', config: { server: `${M}/telegram`, chatId: '-404' } } });
	assert.equal(bad.status, 502);
	assert.equal(bad.data.message, 'HTTP 400: Bad Request: chat not found');
	const badMail = await admin.post('/api/settings/notifications/test', { id: ids.email, channel: { ...CHANNELS[7], secrets: { password: 'wrong' } } });
	assert.match(badMail.data.message, /535 Authentication credentials invalid/);

	assert.equal(
		(
			await admin.put('/api/settings/notifications', {
				rules: [
					{ name: 'Everything', printers: 'all', events: ['print.started', 'print.progress', 'print.paused', 'print.finished', 'print.failed', 'print.cancelled', 'printer.offline', 'printer.online', 'printer.error', 'printer.hot'], channels: Object.values(ids) },
					{ name: 'Only MK4 failures', printers: [printer.id], events: ['print.failed'], channels: [ids.ntfy] }
				]
			})
		).status,
		200
	);
	http.clear();
	smtp.messages.splice(0);

	// --- a print to completion: started, 50 %, finished with a snapshot, then still hot --------
	log('a print started by the operator, to completion');
	await upload('notify-done.gcode', timedGcode(16));
	assert.equal((await operator.post(`/api/printers/${printer.id}/files/select`, { origin: 'local', path: 'notify-done.gcode', print: true })).status, 200);
	const webhooks = () => http.find('/hook/print').map((r) => r.json);
	const kinds = () => webhooks().map((w) => w.event);
	await waitFor(() => kinds().includes('print.started'), 'print.started');
	const started = webhooks().find((w) => w.event === 'print.started');
	assert.equal(started.print.file, 'notify-done.gcode');
	await waitFor(() => kinds().includes('print.progress'), 'the 50 % milestone', { tries: 80 });
	assert.match(webhooks().find((w) => w.event === 'print.progress').title, /^50% done: notify-done\.gcode$/);
	await waitFor(() => kinds().includes('print.finished'), 'print.finished', { tries: 120 });
	const fin = webhooks().find((w) => w.event === 'print.finished');
	assert.equal(fin.printer.name, 'Prusa MK4');
	assert.equal(fin.url, `${APP}/p/${printer.id}?tab=jobs`);
	assert.equal(fin.print.startedBy, OPERATOR.name);
	assert.ok(fin.print.filamentMm > 0);
	assert.equal(fin.image.contentType, 'image/jpeg', 'webhook: the snapshot inline');
	// Every channel got the finished print, with the picture where it can take one.
	await waitFor(() => smtp.messages.some((m) => /Subject: Print finished/.test(m.raw)), 'the email');
	const finTitle = 'Print finished: notify-done.gcode';
	assert.ok(http.find('/ntfy/prints').some((r) => r.method === 'PUT' && r.headers['x-title'] === finTitle && r.headers['x-filename'] === 'snapshot.jpg'), 'ntfy attachment');
	const discord = http.find('/discord').find((r) => r.form && JSON.parse(r.form.payload_json).embeds[0].title === finTitle);
	assert.ok(discord.files['files[0]'].size > 1000, 'discord picture');
	const tg = http.find('/telegram/bot123456:e2e-token/sendPhoto').find((r) => r.form.caption.includes(finTitle));
	assert.ok(tg.files.photo.size > 1000, 'telegram photo');
	assert.ok(http.find('/pushover').find((r) => r.form.title === finTitle).files.attachment.size > 1000, 'pushover attachment');
	assert.ok(http.find('/matrix').some((r) => r.path.includes('/media/v3/upload')), 'matrix upload');
	const slack = http.find('/slack').find((r) => r.json.blocks[0].text.text === finTitle);
	const img = slack.json.blocks.find((b) => b.type === 'image');
	assert.ok(img.image_url.startsWith(`${APP}/api/notify/media/`), 'slack: picture by link');
	const media = await fetch(img.image_url);
	assert.equal(media.status, 200, 'the link works without signing in');
	assert.equal(media.headers.get('content-type'), 'image/jpeg');
	assert.equal((await fetch(`${APP}/api/notify/media/${'x'.repeat(43)}.jpg`)).status, 404);
	const haSvc = http.find('/ha/api/services/notify/mobile_app_phone').find((r) => r.json.title === finTitle);
	assert.equal(haSvc.headers.authorization, 'Bearer ha-llt');
	assert.equal(haSvc.json.data.image, img.image_url, 'one shared link per event');
	assert.ok(http.find('/gotify').some((r) => r.json.title === finTitle && r.json.extras['client::notification'].bigImageUrl));
	const mail = smtp.messages.find((m) => /Subject: Print finished/.test(m.raw));
	assert.match(mail.raw, /Content-ID: <snapshot@octo-modern>/);
	assert.equal(mail.secure, true, 'STARTTLS');
	log('  still hot after the print (bed ≥ 30 °C 15 s later)');
	await waitFor(() => kinds().includes('printer.hot'), 'printer.hot', { tries: 90 });
	assert.match(webhooks().find((w) => w.event === 'printer.hot').message, /bed \d+ °C/);

	// --- quiet hours on email from now on (errors not allowed through) ---------------------------
	await admin.put(`/api/settings/notifications/channels/${ids.email}`, { ...CHANNELS[7], secrets: {}, quiet: { enabled: true, start: '00:00', end: '23:59', allowCritical: false } });

	// --- a print that pauses in its G-code, then the operator pauses and cancels -------------------
	log('a print with M0 in it; then paused and cancelled by the operator');
	http.clear();
	await upload('notify-pause.gcode', timedGcode(60, { pauseAt: 3 }));
	assert.equal((await operator.post(`/api/printers/${printer.id}/files/select`, { origin: 'local', path: 'notify-pause.gcode', print: true })).status, 200);
	await waitFor(() => kinds().includes('print.paused'), 'paused by the G-code', { tries: 80 });
	const paused1 = webhooks().find((w) => w.event === 'print.paused');
	assert.equal(paused1.print.reason, 'pause in the G-code (M0)', JSON.stringify(paused1.print));
	assert.equal((await operator.post(`/api/printers/${printer.id}/job`, { command: 'resume' })).status, 200);
	await waitFor(async () => (await opState()).startsWith('Printing'), 'resumed');
	await sleep(3000);
	assert.equal((await operator.post(`/api/printers/${printer.id}/job`, { command: 'pause' })).status, 200);
	await waitFor(() => webhooks().filter((w) => w.event === 'print.paused').length >= 2, 'paused by the operator', { tries: 60 });
	const paused2 = webhooks().filter((w) => w.event === 'print.paused')[1];
	assert.equal(paused2.print.pausedBy, OPERATOR.name);
	assert.equal(paused2.print.reason, null);
	assert.equal((await operator.post(`/api/printers/${printer.id}/job`, { command: 'cancel', confirm: true })).status, 200);
	await waitFor(() => kinds().includes('print.cancelled'), 'print.cancelled', { tries: 120 });
	assert.equal(webhooks().find((w) => w.event === 'print.cancelled').print.cancelledBy, OPERATOR.name);
	assert.match(webhooks().find((w) => w.event === 'print.cancelled').message, /cancelled by Otto Operator/);

	// --- offline and back ---------------------------------------------------------------------
	log('the OctoPrint container stops and starts again');
	execFileSync('docker', ['stop', `${OP_PREFIX}1`], { stdio: 'ignore' });
	await waitFor(() => kinds().includes('printer.offline'), 'printer.offline', { tries: 120 });
	execFileSync('docker', ['start', `${OP_PREFIX}1`], { stdio: 'ignore' });
	await waitFor(async () => (await op('GET', '/api/version')).server, 'OctoPrint back', { tries: 120 });
	await op('POST', '/api/connection', { command: 'connect', port: 'VIRTUAL', baudrate: 0 });
	await waitFor(() => kinds().includes('printer.online'), 'printer.online', { tries: 120 });
	assert.equal(kinds().filter((k) => k === 'printer.offline').length, 1, 'one offline message');

	// --- the log -----------------------------------------------------------------------------------
	const logRes = await admin.get('/api/settings/notifications/log?limit=100');
	const items = logRes.data.items;
	assert.ok(items.some((d) => d.channelName === 'Email' && d.status === 'quiet'), 'quiet hours held email back');
	assert.ok(items.some((d) => d.kind === 'print.finished' && d.channelType === 'telegram' && d.status === 'sent' && d.image));
	assert.ok(!items.some((d) => d.status === 'failed'), `no failures: ${JSON.stringify(items.filter((d) => d.status === 'failed'))}`);
	const audit = await admin.get('/api/audit?action=notifications.');
	assert.equal(audit.status, 200);

	// --- backup round trip of notifications and history -------------------------------------------
	log('backup: notifications and print history, restored');
	const PASS = 'notify e2e passphrase';
	const exp = await fetch(`${APP}/api/backup`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: admin.cookie, origin: APP },
		body: JSON.stringify({ passphrase: PASS, include: { printers: false, users: false, settings: false, notifications: true, history: true, historyImages: true } })
	});
	assert.equal(exp.status, 200);
	const file = await exp.text();
	assert.ok(!file.includes('e2e-token'), 'encrypted');
	const preview = await admin.post('/api/backup/restore', { file, passphrase: PASS, mode: 'preview' });
	assert.equal(preview.status, 200, JSON.stringify(preview.data));
	assert.equal(preview.data.notifications.channels.length, 10);
	assert.deepEqual(preview.data.history, { total: 2, added: 0, images: true });
	// Remove a channel, then restore: it's back, with its secret.
	await admin.del(`/api/settings/notifications/channels/${ids.telegram}?confirm=1`);
	const applied = await admin.post('/api/backup/restore', { file, passphrase: PASS, mode: 'apply', apply: { notifications: true, history: true } });
	assert.equal(applied.status, 200, JSON.stringify(applied.data));
	assert.deepEqual(applied.data.history, { added: 0, skipped: 2 });
	const after = (await admin.get('/api/settings/notifications')).data;
	assert.equal(after.channels.length, 10);
	assert.equal((await admin.post('/api/settings/notifications/test', { id: ids.telegram })).status, 200, 'restored secrets work');
	assert.equal(after.rules.length, 2);

	// --- browser: the page, a failing test in the editor, phone layout, screenshots ---------------
	log('browser: Notifications page and screenshots');
	browser = await chromium.launch();
	const newPage = async (theme, viewport = { width: 1440, height: 1000 }, mobile = false) => {
		const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
		await ctx.addInitScript((t) => localStorage.setItem('ocm-theme', t), theme);
		const page = await ctx.newPage();
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
		page.errors = errors;
		await page.goto(`${APP}/login`);
		await page.waitForLoadState('networkidle');
		await page.fill('#email', ADMIN.email);
		await page.fill('#pw', ADMIN.password);
		await page.click('button:has-text("Sign in")');
		await page.waitForURL((u) => !u.pathname.startsWith('/login'));
		return page;
	};
	const shot = async (page, name, opts = {}) => {
		await page.screenshot({ path: join(SHOTS, `${name}.png`), ...opts });
		log(`  screenshot ${name}.png`);
	};
	const dark = await newPage('dark');
	await dark.goto(`${APP}/notifications`);
	await dark.waitForSelector('[data-channel="Telegram family"]');
	await dark.waitForSelector('[data-testid=delivery-table]');
	// The page scrolls inside the shell: a tall window shows all of it.
	await dark.setViewportSize({ width: 1440, height: 2700 });
	await sleep(500);
	await shot(dark, 'notifications');
	await dark.setViewportSize({ width: 1440, height: 1000 });

	// Add a Telegram channel whose test fails: the exact error shows in the dialog.
	await dark.click('main button:has-text("Add channel") >> nth=0');
	await dark.click('[data-type=telegram]');
	await dark.fill('#ch-name', 'Workshop group');
	await dark.fill('#ch-botToken', '000:bad');
	await dark.fill('#ch-chatId', '-1009');
	await dark.fill('#ch-server', `${M}/telegram`);
	await dark.click('dialog button:has-text("Send test")');
	await dark.waitForSelector('[data-testid=channel-test-error]');
	assert.equal(await dark.textContent('[data-testid=channel-test-error]'), 'HTTP 401: Unauthorized');
	await shot(dark, 'notifications-channel');
	await dark.fill('#ch-botToken', '123456:workshop');
	await dark.click('dialog button:has-text("Send test")');
	await dark.waitForSelector('[data-testid=channel-test] >> text=Delivered');
	await dark.click('dialog button:has-text("Add channel")');
	await dark.waitForSelector('[data-channel="Workshop group"]');

	// A rule from the editor.
	await dark.click('section button:has-text("Add rule")');
	await dark.fill('#rule-name', 'Workshop: failures');
	await dark.click('dialog button:has-text("Add rule")');
	await dark.waitForSelector('[data-rule="Workshop: failures"]');

	const light = await newPage('light');
	await light.goto(`${APP}/notifications`);
	await light.waitForSelector('[data-testid=delivery-table]');
	await light.evaluate(() => document.getElementById('rules-h')?.scrollIntoView({ block: 'start' }));
	await sleep(400);
	await shot(light, 'notifications-light');

	const phone = await newPage('dark', { width: 390, height: 844 }, true);
	await phone.goto(`${APP}/notifications`);
	await phone.waitForSelector('[data-testid=delivery-list]');
	const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 0, `no horizontal scroll at 390 px (${overflow})`);
	await sleep(400);
	await shot(phone, 'notifications-phone');
	await phone.click('[data-channel="Phone (ntfy)"] button[aria-label^="More actions"]');
	await phone.waitForSelector('[role=menu] >> text=Send test');
	await phone.click('[role=menuitem]:has-text("Send test")');
	await phone.waitForSelector('text=Test sent to Phone (ntfy)');

	for (const p of [dark, light, phone]) assert.deepEqual(p.errors, [], 'no browser errors');
	// Nothing went anywhere but the mocks.
	assert.ok(http.requests.every((r) => r.headers.host === `127.0.0.1:${MOCK_PORT}`));
	log('all notification e2e checks passed');
}

async function cleanup(ok) {
	await browser?.close().catch(() => {});
	await cam?.close().catch(() => {});
	if (process.env.E2E_KEEP) {
		log(`E2E_KEEP: app still running on ${APP} (pid ${app?.pid}), data in ${dataDir}`);
		return;
	}
	await http?.close().catch(() => {});
	await smtp?.close().catch(() => {});
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
