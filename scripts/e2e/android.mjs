// End-to-end test of the Android app on an emulator, against a local octo·modern and a mock
// OctoPrint (nothing real is contacted). Drives the app's WebView through Chrome DevTools
// (debug builds are debuggable) and the native parts (notifications, widget, dialogs) with
// adb, and refreshes docs/screenshots/android-*.png.
//
//   pnpm build && (cd android-app/android && ./gradlew assembleDebug)
//   E2E_SKIP_BUILD=1 pnpm e2e:android
//
// Needs a running emulator (ANDROID_SERIAL, default emulator-5754; start it with -gpu host:
// the software renderer leaves stale tiles in screenshots) and adb on PATH (or
// ANDROID_HOME). The emulator reaches this Mac at 10.0.2.2.
// Ports 5700–5703 (E2E_PORT_BASE moves them): app +0, OctoPrint +1, second OctoPrint +2,
// the WebView's DevTools socket +90.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const PORT_BASE = Number(process.env.E2E_PORT_BASE ?? 5700);
const APP_PORT = PORT_BASE;
const APP = `http://127.0.0.1:${APP_PORT}`;
const FROM_EMULATOR = `http://10.0.2.2:${APP_PORT}`;
const DEVTOOLS_PORT = PORT_BASE + 90;
const PKG = 'io.github.vitafortis.octomodern';
const SERIAL = process.env.ANDROID_SERIAL ?? 'emulator-5754';
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OP_KEY = 'e2e-octoprint-key';
const ADB = process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools/adb') : existsSync(join(homedir(), 'Library/Android/sdk/platform-tools/adb')) ? join(homedir(), 'Library/Android/sdk/platform-tools/adb') : 'adb';
const APK =
	process.env.APK ??
	(() => {
		const dir = join(ROOT, 'android-app/android/app/build/outputs/apk/debug');
		const f = existsSync(dir) ? readdirSync(dir).find((n) => n.endsWith('.apk')) : null;
		return f ? join(dir, f) : null;
	})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const closers = [];
let app;
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-android-'));

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

// --- adb -------------------------------------------------------------------------------------

const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sh = (cmd) => adb('shell', cmd);
const screenshot = (name) => {
	const png = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
	writeFileSync(join(SHOTS, `android-${name}.png`), png);
	log(`screenshot android-${name}.png`);
};

/** The UI hierarchy, as [{ text, desc, id, bounds: [x1,y1,x2,y2] }]. */
function uiNodes() {
	sh('uiautomator dump /sdcard/ui.xml >/dev/null');
	const xml = sh('cat /sdcard/ui.xml');
	const nodes = [];
	for (const m of xml.matchAll(/<node [^>]*>/g)) {
		const a = (k) => (new RegExp(`${k}="([^"]*)"`).exec(m[0]) ?? [])[1] ?? '';
		const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a('bounds'));
		nodes.push({ text: a('text'), desc: a('content-desc'), id: a('resource-id'), pkg: a('package'), bounds: b ? b.slice(1).map(Number) : null });
	}
	return nodes;
}

function tapNode(pred, label) {
	const n = uiNodes().find(pred);
	if (!n || !n.bounds) throw new Error(`no ${label} on screen`);
	const [x1, y1, x2, y2] = n.bounds;
	sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
	return n;
}

/** Our notifications as dumpsys shows them: [{ id, title, text, progress, actions }]. */
function notifications() {
	const out = sh('dumpsys notification --noredact');
	const list = [];
	for (const block of out.split(/\n\s+NotificationRecord\(/).slice(1)) {
		if (!block.includes(`pkg=${PKG}`)) continue;
		const get = (k) => (new RegExp(`${k}=String \\(([^\\n]*)\\)`).exec(block) ?? [])[1] ?? null;
		const progress = /android\.progress=Integer \((\d+)\)/.exec(block);
		const actions = [...block.matchAll(/\[\d+\] "([^"]+)" ->/g)].map((m) => m[1]);
		list.push({ id: Number((/id=(\d+)/.exec(block) ?? [])[1]), title: get('android.title'), text: get('android.text'), progress: progress ? Number(progress[1]) : null, actions, channel: (/channel=(\w+)/.exec(block) ?? [])[1] });
	}
	return list;
}

// --- the WebView, over Chrome DevTools ------------------------------------------------------

async function devtools() {
	const sockets = sh('cat /proc/net/unix');
	const pid = sh(`pidof ${PKG}`).trim();
	const name = `webview_devtools_remote_${pid}`;
	assert.ok(sockets.includes(name), 'the WebView is debuggable (debug build)');
	try {
		adb('forward', '--remove', `tcp:${DEVTOOLS_PORT}`);
	} catch {}
	adb('forward', `tcp:${DEVTOOLS_PORT}`, `localabstract:${name}`);
}

/** Evaluates `expr` (may return a promise) in the app's WebView page. */
async function page(expr) {
	const targets = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json();
	const t = targets.find((x) => x.type === 'page');
	assert.ok(t, 'a WebView page');
	const ws = new WebSocket(t.webSocketDebuggerUrl);
	await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
	try {
		const res = await new Promise((r, j) => {
			ws.onmessage = (m) => {
				const d = JSON.parse(m.data);
				if (d.id === 1) r(d);
			};
			ws.onerror = j;
			ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
		});
		if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'page error');
		return res.result?.result?.value;
	} finally {
		ws.close();
	}
}

const url = () => page('location.href');
/** Types into an input the way a person would, so frameworks see it. */
const fill = (sel, value) =>
	page(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const click = (sel) => page(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.click(); return true; })()`);

// --- mocks -----------------------------------------------------------------------------------

/** A 640×360 webcam frame of a print in progress. */
async function renderFrame() {
	const b = await chromium.launch();
	const p = await b.newPage({ viewport: { width: 640, height: 360 } });
	await p.setContent(`<style>html,body{margin:0;background:#000}</style><canvas id="c" width="640" height="360"></canvas>`);
	await p.evaluate(() => {
		const g = document.getElementById('c').getContext('2d');
		const bg = g.createLinearGradient(0, 0, 0, 360);
		bg.addColorStop(0, '#24212c');
		bg.addColorStop(1, '#0e0c13');
		g.fillStyle = bg;
		g.fillRect(0, 0, 640, 360);
		g.fillStyle = '#3a3646';
		g.fillRect(40, 40, 14, 260);
		g.fillRect(586, 40, 14, 260);
		g.fillRect(40, 70, 560, 12);
		const bed = g.createLinearGradient(0, 290, 0, 310);
		bed.addColorStop(0, '#4a4558');
		bed.addColorStop(1, '#2a2733');
		g.fillStyle = bed;
		g.fillRect(90, 292, 460, 16);
		for (let l = 0; l < 18; l++) {
			g.fillStyle = `hsl(272, 62%, ${34 + (l % 2) * 4 + l}%)`;
			g.fillRect(200, 286 - l * 6, 150, 5);
		}
		g.fillStyle = '#8a8496';
		g.fillRect(300, 82, 34, 90);
		g.fillStyle = '#c9a227';
		g.beginPath();
		g.moveTo(308, 172);
		g.lineTo(326, 172);
		g.lineTo(317, 182);
		g.fill();
		g.fillStyle = 'rgba(255,255,255,0.55)';
		g.font = '12px monospace';
		g.fillText('CAM 1  01:12:09', 14, 22);
	});
	const jpeg = await p.locator('#c').screenshot({ type: 'jpeg', quality: 85 });
	await b.close();
	return jpeg;
}

/**
 * OctoPrint, REST only (octo·modern polls it): a print that runs `printMinutes`, with
 * pause/resume/cancel, and a webcam snapshot. `printing: false` is an idle printer.
 */
function mockOctoPrint({ printing, printMinutes, file, frame }) {
	const s = { state: printing ? 'Printing' : 'Operational', startedAt: Date.now() - printMinutes * 60_000 * 0.42, pausedAt: 0, pauses: 0, resumes: 0, cancels: 0 };
	const total = printMinutes * 60;
	const elapsed = () => ((s.state === 'Paused' ? s.pausedAt : Date.now()) - s.startedAt) / 1000;
	const server = createServer(async (req, res) => {
		const send = (o, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
		const u = new URL(req.url, 'http://x');
		if (u.pathname === '/webcam/' && u.searchParams.get('action') === 'snapshot') return res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }).end(frame);
		if (req.headers['x-api-key'] !== OP_KEY) return send({ error: 'Forbidden' }, 403);
		const active = s.state !== 'Operational';
		if (u.pathname === '/api/version') return send({ api: '0.1', server: '1.11.2', text: 'OctoPrint 1.11.2' });
		if (u.pathname === '/api/printer') {
			return send({
				state: { text: s.state, flags: { operational: true, printing: s.state === 'Printing', paused: s.state === 'Paused', pausing: false, resuming: false, cancelling: false, finishing: false, ready: !active, error: false, closedOrError: false } },
				temperature: active ? { tool0: { actual: 214.6, target: 215 }, bed: { actual: 59.8, target: 60 } } : { tool0: { actual: 24.1, target: 0 }, bed: { actual: 23.8, target: 0 } }
			});
		}
		if (u.pathname === '/api/job' && req.method === 'GET') {
			const t = active ? Math.round(elapsed()) : null;
			return send({
				job: { file: active ? { name: file, display: file, path: file, origin: 'local', size: 1843200 } : { name: null }, estimatedPrintTime: total, filament: { tool0: { length: 9120, volume: 21.9 } }, user: 'ada' },
				progress: { completion: active ? Math.min(99, (t / total) * 100) : null, printTime: t, printTimeLeft: active ? Math.max(0, total - t) : null, printTimeLeftOrigin: 'estimate', filepos: 1 },
				state: s.state
			});
		}
		if (u.pathname === '/api/job' && req.method === 'POST') {
			let body = '';
			for await (const c of req) body += c;
			const b = JSON.parse(body || '{}');
			if (b.command === 'pause' && b.action === 'pause' && s.state === 'Printing') {
				s.pauses++;
				s.pausedAt = Date.now();
				s.state = 'Paused';
			} else if (b.command === 'pause' && b.action === 'resume' && s.state === 'Paused') {
				s.resumes++;
				s.startedAt += Date.now() - s.pausedAt;
				s.state = 'Printing';
			} else if (b.command === 'cancel' && active) {
				s.cancels++;
				s.state = 'Operational';
			} else return send({ error: 'Printer is not printing' }, 409);
			return res.writeHead(204).end();
		}
		if (u.pathname === '/api/settings') return send({ webcam: { webcamEnabled: true, streamUrl: null, snapshotUrl: '/webcam/?action=snapshot' }, feature: {}, temperature: { profiles: [] } });
		if (u.pathname.startsWith('/api/files')) return send({ files: [], free: 1e10, total: 2e10 });
		if (u.pathname === '/api/printerprofiles') return send({ profiles: {} });
		if (u.pathname === '/api/connection') return send({ current: { state: s.state, port: 'VIRTUAL', baudrate: 115200, printerProfile: '_default' }, options: { ports: ['VIRTUAL'], baudrates: [115200], printerProfiles: [] } });
		send({ error: 'Not found' }, 404);
	});
	return { s, server };
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
	return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), del: (p) => call('DELETE', p, {}) };
}

// --- the test ---------------------------------------------------------------------------------

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	assert.ok(APK && existsSync(APK), 'build the debug APK first (cd android-app/android && ./gradlew assembleDebug)');
	assert.match(execFileSync(ADB, ['devices'], { encoding: 'utf8' }), new RegExp(`${SERIAL}\\s+device`), `emulator ${SERIAL} is running`);

	log('rendering a demo webcam frame; starting two mock OctoPrints');
	const frame = await renderFrame();
	const mk4 = mockOctoPrint({ printing: true, printMinutes: 30, file: 'cable-chain-x12.gcode', frame });
	const voron = mockOctoPrint({ printing: false, printMinutes: 30, file: 'phone_stand.gcode', frame });
	await new Promise((r) => mk4.server.listen(PORT_BASE + 1, '127.0.0.1', r));
	await new Promise((r) => voron.server.listen(PORT_BASE + 2, '127.0.0.1', r));
	closers.push(() => mk4.server.close(), () => voron.server.close());

	if (!process.env.E2E_SKIP_BUILD) {
		log('building');
		execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'ignore' });
	}
	log(`starting octo·modern on ${APP} (the emulator sees ${FROM_EMULATOR})`);
	app = spawn('node', ['build'], {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', OCM_DATA_DIR: dataDir, OCM_POLL_INTERVAL_MS: '2000', OCM_ADMIN_EMAIL: ADMIN.email, OCM_ADMIN_PASSWORD: ADMIN.password, OCM_ADMIN_NAME: ADMIN.name, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' }
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
	const OP = (port) => `http://127.0.0.1:${port}`;
	const printer = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: OP(PORT_BASE + 1), apiKey: OP_KEY, color: 'violet', webcamUrl: `${OP(PORT_BASE + 1)}/webcam/?action=snapshot` })).data;
	(await admin.post('/api/printers', { name: 'Voron 2.4', baseUrl: OP(PORT_BASE + 2), apiKey: OP_KEY, color: 'cyan', webcamUrl: `${OP(PORT_BASE + 2)}/webcam/?action=snapshot` })).data;
	await waitFor(async () => (await admin.get('/api/printers/status')).data.find((s) => s.id === printer.id)?.state === 'printing', 'the MK4 printing');

	// --- install, fresh -----------------------------------------------------------------------
	log(`installing ${APK.split('/').pop()} on ${SERIAL}`);
	adb('install', '-r', '-t', APK);
	sh(`pm clear ${PKG}`);
	sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
	sh('cmd uimode night yes');
	for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) sh(`settings put global ${k} 0`);
	sh('settings put system screen_off_timeout 1800000');
	sh('input keyevent KEYCODE_WAKEUP');
	sh('wm dismiss-keyguard');
	sh('cmd statusbar collapse');
	sh(`am start -W -n ${PKG}/.MainActivity`);
	await sleep(1500);
	await waitFor(async () => (await devtools(), true), 'the WebView DevTools socket', { tries: 30 });

	// --- first launch -------------------------------------------------------------------------
	log('first launch: the setup page checks the server');
	await waitFor(async () => /localhost\/#setup/.test(await url()), 'the setup page', { tries: 30 });
	await fill('#server', 'http://203.0.113.9:3000');
	await click('#connect');
	const refused = await waitFor(() => page(`!document.getElementById('setup-error').hidden && document.getElementById('setup-error').textContent`), 'public http refused');
	assert.match(refused, /https/);
	await fill('#server', FROM_EMULATOR);
	await click('#connect');
	await waitFor(() => page(`!document.getElementById('setup-warning').hidden`), 'the plain-http warning');
	await page('document.activeElement && document.activeElement.blur()');
	await sleep(400);
	screenshot('setup');
	await click('#connect');
	await waitFor(async () => (await url()).startsWith(`${FROM_EMULATOR}/login`), 'the server’s sign-in page', { tries: 40 });

	log('signing in inside the app');
	await waitFor(() => page(`!!document.querySelector('#email')`), 'the sign-in form');
	await fill('#email', ADMIN.email);
	await fill('#pw', ADMIN.password);
	await page(`document.querySelector('form').requestSubmit()`);
	await waitFor(async () => new URL(await url()).pathname === '/', 'the dashboard', { tries: 40 });

	log('the app links itself: a device token on My account');
	const device = await waitFor(async () => (await admin.get('/api/account/devices')).data.find((d) => !d.revokedAt), 'a linked device', { tries: 40 });
	assert.match(device.name, /\(Android app\)$/);
	assert.match(device.prefix, /^ocd_/);
	const ua = await page('navigator.userAgent');
	assert.match(ua, /OctoModernAndroid\//);

	log('the dashboard with the live camera');
	await waitFor(() => page(`[...document.images].some((i) => /webcam/.test(i.src) && i.complete && i.naturalWidth > 0)`), 'the webcam image', { tries: 40 });
	await sleep(1500);
	screenshot('app');

	// --- progress notification ----------------------------------------------------------------
	log('a print is running: the app starts the progress notification');
	const progress = () => notifications().find((n) => n.title?.startsWith('Prusa MK4 ·'));
	const first = await waitFor(progress, 'the progress notification', { tries: 60 });
	assert.match(first.title, /Prusa MK4 · cable-chain-x12\.gcode/);
	assert.match(first.text, /^\d+% · \d+m left/);
	assert.deepEqual(first.actions, ['Pause', 'Cancel']);
	assert.ok(first.progress >= 40 && first.progress <= 60, `progress ${first.progress}`);

	log('backgrounded: it keeps updating');
	sh('input keyevent KEYCODE_HOME');
	await waitFor(() => (progress()?.progress ?? 0) > first.progress, 'the progress moving on', { tries: 60, every: 1000 });
	assert.ok(sh('dumpsys activity services ' + PKG).includes('PrintWatchService'), 'the watcher runs as a foreground service');

	sh('cmd statusbar expand-notifications');
	await sleep(1500);
	screenshot('notification');

	log('Pause from the notification pauses the printer');
	tapNode((n) => n.text === 'Pause' && n.pkg === 'com.android.systemui', 'the Pause action');
	await waitFor(() => mk4.s.state === 'Paused', 'the mock paused', { tries: 30 });
	await waitFor(() => progress()?.actions.includes('Resume'), 'Resume offered', { tries: 30 });
	assert.ok((await admin.get('/api/audit?action=job.pause')).data.some((e) => e.userEmail === ADMIN.email), 'audited as the user');
	sh('cmd statusbar expand-notifications');
	await sleep(800);
	tapNode((n) => n.text === 'Resume' && n.pkg === 'com.android.systemui', 'the Resume action');
	await waitFor(() => mk4.s.state === 'Printing', 'the mock printing again', { tries: 30 });
	sh('cmd statusbar collapse');

	// --- settings and the widget ----------------------------------------------------------------
	log('app settings');
	sh(`am start -W -a android.intent.action.VIEW -d octomodern://settings -n ${PKG}/.MainActivity`);
	await waitFor(async () => /localhost\/#settings/.test(await url()), 'the settings page', { tries: 30 });
	await waitFor(() => page(`document.getElementById('s-account').textContent.includes('Ada Admin')`), 'the account', { tries: 30 });
	await waitFor(() => page(`!document.getElementById('widget-card').hidden`), 'the widget card', { tries: 30 });
	await sleep(1500);
	screenshot('settings');

	log('adding the widget for the MK4');
	await click(`#widget-list button[data-printer="${printer.id}"]`);
	await sleep(1500);
	tapNode((n) => /^(Add to home screen|Add automatically|Add)$/i.test(n.text) && n.pkg !== PKG, 'the launcher’s Add button');
	await sleep(1000);
	sh('input keyevent KEYCODE_HOME');
	const widgetShown = () => uiNodes().some((n) => n.pkg === PKG && /Printing · \d+%/.test(n.text));
	await waitFor(widgetShown, 'the widget on the home screen', { tries: 40, every: 1000 });
	await waitFor(() => uiNodes().some((n) => n.pkg === PKG && n.desc === 'Webcam snapshot'), 'the snapshot in the widget', { tries: 40, every: 1000 });
	await sleep(1000);
	screenshot('widget');

	// --- cancel, with confirmation -----------------------------------------------------------
	log('Cancel asks first, then cancels; a “cancelled” notification follows');
	sh('cmd statusbar expand-notifications');
	await sleep(1000);
	tapNode((n) => n.text === 'Cancel' && n.pkg === 'com.android.systemui', 'the Cancel action');
	await waitFor(() => uiNodes().some((n) => n.pkg === PKG && /Cancel the print on Prusa MK4\?/.test(n.text)), 'the confirmation', { tries: 20 });
	assert.equal(mk4.s.cancels, 0, 'nothing cancelled before confirming');
	tapNode((n) => n.pkg === PKG && n.text === 'Cancel print', 'Cancel print');
	await waitFor(() => mk4.s.cancels === 1, 'the mock cancelled', { tries: 30 });
	const done = await waitFor(() => notifications().find((n) => n.title === 'Prusa MK4: print cancelled'), 'the cancelled notification', { tries: 60 });
	assert.match(done.text, /cable-chain-x12\.gcode · stopped at \d+%/);
	await waitFor(() => !progress(), 'the progress notification gone', { tries: 30 });

	// --- sign out from the app -------------------------------------------------------------------
	log('signing out in the app revokes the device');
	sh('cmd statusbar collapse');
	sh(`am start -W -a android.intent.action.VIEW -d octomodern://settings -n ${PKG}/.MainActivity`);
	await waitFor(async () => /localhost\/#settings/.test(await url()), 'the settings page', { tries: 30 });
	await waitFor(() => page(`!document.getElementById('sign-out').hidden`), 'Sign out', { tries: 30 });
	await page(`window.confirm = () => true; document.getElementById('sign-out').click(); true`);
	await waitFor(async () => (await admin.get('/api/account/devices')).data.every((d) => d.revokedAt), 'the device revoked', { tries: 40 });
	await waitFor(async () => (await url()).startsWith(`${FROM_EMULATOR}/login`), 'back at sign-in', { tries: 40 });
	log('all good');
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			execFileSync(ADB, ['-s', SERIAL, 'forward', '--remove', `tcp:${DEVTOOLS_PORT}`]);
		} catch {}
		for (const c of closers) c();
		app?.kill();
		setTimeout(() => process.exit(), 500).unref();
	});
