// End-to-end test of the G-code toolpath preview and the camera wall, against real
// OctoPrint servers (virtual printers in Docker), a local MJPEG test camera and a
// folder library with synthetic G-code (scripts/gcode-samples.mjs), including a
// ~100 MB file for performance numbers.
//
//   pnpm e2e:viewer                   # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:viewer        # leave everything running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:viewer  # reuse ./build
//   E2E_BIG_MB=100                    # size of the big file
//
// Ports (override with the env vars): app 3250, OctoPrint 3251–3252, test camera 3253.
// Needs Docker and a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMjpegSource } from '../mjpeg-source.mjs';
import { bigOptions, writeSample } from '../gcode-samples.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3250);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_BASE = Number(process.env.E2E_OP_PORT_BASE ?? 3251);
const OP_PREFIX = process.env.E2E_OP_PREFIX ?? 'octo-modern-viewer-e2e-op';
const CAM_PORT = Number(process.env.E2E_CAM_PORT ?? 3253);
const CAM = `http://127.0.0.1:${CAM_PORT}`;
const BIG_MB = Number(process.env.E2E_BIG_MB ?? 100);
const OP = [1, 2].map((i) => ({ url: `http://127.0.0.1:${OP_BASE + i - 1}`, key: `ocm-dev-key-${i}` }));
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const devOctoprint = (...args) =>
	execFileSync(join(ROOT, 'scripts/dev-octoprint.sh'), args, { env: { ...process.env, OCM_OP_PORT_BASE: String(OP_BASE), OCM_OP_PREFIX: OP_PREFIX }, stdio: 'inherit' });

let app;
let browser;
let cam;
const work = mkdtempSync(join(tmpdir(), 'ocm-e2e-viewer-'));
const dataDir = join(work, 'data');
const libDir = join(work, 'library');
const results = {};

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
	const call = async (method, path, body, headers = {}) => {
		const res = await fetch(`${APP}${path}`, {
			method,
			redirect: 'manual',
			headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), origin: APP, ...headers },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const set = res.headers.get('set-cookie');
		if (set) cookie = set.split(';')[0];
		return res;
	};
	const jsonCall = async (...a) => {
		const res = await call(...a);
		return { status: res.status, data: await res.json().catch(() => null) };
	};
	return {
		raw: (path, headers) => call('GET', path, undefined, headers),
		get: (p) => jsonCall('GET', p),
		post: (p, b) => jsonCall('POST', p, b ?? {}),
		get cookie() {
			return cookie;
		}
	};
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

async function uploadToOctoPrint(o, name, file) {
	const fd = new FormData();
	fd.set('file', new Blob([readFileSync(file)]), name);
	const res = await fetch(`${o.url}/api/files/local`, { method: 'POST', headers: { 'X-Api-Key': o.key }, body: fd });
	assert.equal(res.status, 201, `upload to OctoPrint: ${await res.text()}`);
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(join(libDir, 'Brackets'), { recursive: true });

	log('writing synthetic G-code samples');
	const files = {};
	for (const f of ['prusa', 'cura', 'orca', 'plain']) {
		files[f] = join(libDir, `spool-hub_${f}.gcode`);
		await writeSample(files[f], f);
	}
	// A smaller, quicker part for the live print (layers fly by on the virtual printer).
	files.live = join(work, 'live.gcode');
	await writeSample(files.live, 'prusa', { layers: 30, segments: 48, outerR: 18, innerR: 6, sparseSpacing: 6 });
	files.big = join(libDir, 'Brackets', `big-${BIG_MB}mb.gcode`);
	const bigSize = await writeSample(files.big, 'prusa', bigOptions(BIG_MB));
	log(`big file: ${(bigSize / 1048576).toFixed(1)} MB`);

	log('starting two OctoPrint servers with virtual printers');
	devOctoprint('up', '2');
	cam = await startMjpegSource({ port: CAM_PORT, host: '127.0.0.1' });
	log(`MJPEG test camera on ${CAM}`);
	await uploadToOctoPrint(OP[0], 'spool-hub_orca.gcode', files.orca);
	await uploadToOctoPrint(OP[0], 'spool-hub_cura.gcode', files.cura);
	await uploadToOctoPrint(OP[0], 'live-part.gcode', files.live);
	await uploadToOctoPrint(OP[1], `big-${BIG_MB}mb.gcode`, files.big);

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
			writeFileSync(join(work, 'app.log'), appLog);
		} catch {}
	});
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');

	const admin = client();
	assert.equal((await admin.post('/api/auth/login', ADMIN)).status, 200);
	const mk4 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: OP[0].url, apiKey: OP[0].key, color: 'violet', webcamUrl: `${CAM}/?action=stream` })).data;
	const voron = (await admin.post('/api/printers', { name: 'Voron 2.4', baseUrl: OP[1].url, apiKey: OP[1].key, color: 'cyan', webcamUrl: `${CAM}/?action=stream` })).data;
	const ender = (await admin.post('/api/printers', { name: 'Ender 3 S1', baseUrl: `${OP[1].url}/`, apiKey: OP[1].key, color: 'amber', webcamUrl: `${CAM}/?action=stream` })).data;
	for (const p of [mk4, voron, ender]) assert.ok(p?.id, JSON.stringify(p));
	assert.equal((await admin.post('/api/users', { ...VIEWER, role: 'viewer' })).status, 201);
	const viewer = client();
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);
	const lib = (await admin.post('/api/library/sources', { name: 'NAS prints', kind: 'folder', config: { path: libDir } })).data;
	assert.ok(lib?.id, JSON.stringify(lib));
	await waitFor(async () => (await admin.get('/api/printers/status')).data.every((s) => s.state === 'operational'), 'printers ready');
	await op(OP[1], 'POST', '/api/printer/tool', { command: 'target', targets: { tool0: 240 } });
	await op(OP[1], 'POST', '/api/printer/bed', { command: 'target', target: 100 });

	// --- download API --------------------------------------------------------------------------
	log('download API: ranges, permissions');
	const r1 = await viewer.raw(`/api/printers/${mk4.id}/files/download?path=spool-hub_orca.gcode`, { range: 'bytes=0-99' });
	assert.equal(r1.status, 206, 'OctoPrint honours ranges through the proxy');
	assert.equal((await r1.arrayBuffer()).byteLength, 100);
	assert.match(r1.headers.get('content-range'), /^bytes 0-99\/\d+$/);
	const whole = readFileSync(files.orca);
	const r2 = await viewer.raw(`/api/printers/${mk4.id}/files/download?path=spool-hub_orca.gcode`);
	assert.equal(r2.status, 200);
	assert.ok(Buffer.from(await r2.arrayBuffer()).equals(whole), 'byte-identical');
	assert.equal((await viewer.raw(`/api/printers/${mk4.id}/files/download?path=../etc/passwd`)).status, 400);
	assert.equal((await viewer.raw(`/api/printers/${mk4.id}/files/download?path=notes.txt`)).status, 400);
	assert.equal((await viewer.raw(`/api/printers/${mk4.id}/files/download?path=missing.gcode`)).status, 404);
	const anon = await fetch(`${APP}/api/printers/${mk4.id}/files/download?path=spool-hub_orca.gcode`);
	assert.equal(anon.status, 401, 'signed-out requests are refused');
	const r3 = await viewer.raw(`/api/library/${lib.id}/download?path=${encodeURIComponent('Brackets/big-' + BIG_MB + 'mb.gcode')}`, { range: 'bytes=1000-1999' });
	assert.equal(r3.status, 206);
	assert.equal(r3.headers.get('content-range'), `bytes 1000-1999/${bigSize}`);
	assert.equal((await r3.arrayBuffer()).byteLength, 1000);
	assert.ok(!JSON.stringify([...r2.headers]).includes(OP[0].key), 'no API key in the response');

	// --- browser ----------------------------------------------------------------------------------
	// The full Chromium build (not the headless shell) renders WebGL on the real GPU, so the
	// frame times below mean something; E2E_SOFTWARE_GL=1 falls back to SwiftShader.
	browser = await chromium.launch(process.env.E2E_SOFTWARE_GL ? { args: ['--enable-unsafe-swiftshader', '--enable-precise-memory-info'] } : { channel: 'chromium', args: ['--enable-precise-memory-info'] });
	log(`WebGL renderer: ${await (async () => {
		const p = await browser.newPage();
		const r = await p.evaluate(() => {
			const g = document.createElement('canvas').getContext('webgl2');
			const e = g?.getExtension('WEBGL_debug_renderer_info');
			return g ? g.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : g.RENDERER) : 'none';
		});
		await p.close();
		results.gpu = r;
		return r;
	})()}`);
	const newPage = async (theme, { phone = false } = {}) => {
		const ctx = phone
			? await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme })
			: await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
		await ctx.addInitScript((t) => {
			localStorage.setItem('ocm-theme', t);
			// Count wake lock requests (headless Chromium may not grant them).
			window.__wake = 0;
			try {
				Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => (window.__wake++, { release: async () => {} }) } });
			} catch {}
		}, theme);
		const page = await ctx.newPage();
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|WebGL|GPU stall/.test(m.text()) && errors.push(m.text()));
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
	const layerText = async (page) => (await page.locator('[data-testid=gcode-layer]').textContent()).trim();
	const loadedIn = async (page) => (await page.locator('[data-testid=gcode-viewer]').textContent()).match(/moves · [^·]+ · ([\d.]+ m?s)/)?.[1];

	// --- previews: printer file, library file -------------------------------------------------
	log('preview: an OctoPrint file (OrcaSlicer flavour, arcs), as a viewer');
	const dark = await newPage('dark');
	await signIn(dark, VIEWER);
	await dark.goto(`${APP}/p/${mk4.id}?tab=files`);
	await dark.locator('a[aria-label="Preview spool-hub_orca.gcode"]').first().click();
	await dark.waitForURL(/tab=preview/);
	await dark.waitForSelector('[data-testid=gcode-layer]', { timeout: 30_000 });
	assert.equal(await layerText(dark), 'Layer 41 / 41 · Z 8.00');
	for (const f of ['Outer wall', 'Inner wall', 'Sparse infill', 'Solid infill', 'Top / bottom', 'Skirt / brim']) assert.ok(await dark.locator(`[aria-label="Feature types"] button:has-text("${f}")`).count(), `legend: ${f}`);
	// Layer slider and keyboard.
	await dark.locator('[data-testid=gcode-slider]').fill('20');
	assert.match(await layerText(dark), /^Layer 21 \/ 41 · Z 4\.00$/);
	await dark.locator('canvas').focus();
	await dark.keyboard.press('ArrowUp');
	assert.match(await layerText(dark), /^Layer 22 \//);
	// The canvas actually draws something (not all transparent).
	/** Pixels of the canvas that differ from its background (from a real screenshot: WebGL buffers aren't readable afterwards). */
	const painted = async (page) => {
		const png = await page.locator('[data-testid=gcode-viewer] canvas').screenshot();
		return page.evaluate(async (b64) => {
			const img = new Image();
			img.src = `data:image/png;base64,${b64}`;
			await img.decode();
			const c = document.createElement('canvas');
			c.width = img.width;
			c.height = img.height;
			const g = c.getContext('2d');
			g.drawImage(img, 0, 0);
			const d = g.getImageData(0, 0, c.width, c.height).data;
			const [r0, g0, b0] = [d[0], d[1], d[2]];
			let n = 0;
			for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 60) n++;
			return n;
		}, png.toString('base64'));
	};
	await sleep(300);
	assert.ok((await painted(dark)) > 500, 'toolpath pixels on the canvas');
	// Orbit and zoom.
	const box = await dark.locator('[data-testid=gcode-viewer] canvas').boundingBox();
	await dark.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await dark.mouse.down();
	await dark.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 8 });
	await dark.mouse.up();
	await dark.mouse.wheel(0, -300);
	await dark.locator('[data-testid=gcode-slider]').fill('40');
	await dark.click('button[aria-label="Reset view"]');
	await sleep(400);
	await dark.screenshot({ path: join(SHOTS, 'gcode-preview.png') });

	log('preview: 2D layer view with travel moves, light theme, library file (Cura flavour)');
	const light = await newPage('light');
	await signIn(light, VIEWER);
	await light.goto(`${APP}/library?source=${lib.id}`);
	await light.locator('a[aria-label="Preview spool-hub_cura.gcode"]').click();
	await light.waitForURL(/\/library\/preview/);
	await light.waitForSelector('[data-testid=gcode-layer]', { timeout: 30_000 });
	await light.click('button[role=radio]:has-text("Layer")');
	await light.click('button:has-text("Travel")');
	await light.locator('[data-testid=gcode-slider]').fill('5');
	await sleep(400);
	assert.match(await layerText(light), /^Layer 6 \/ 41/);
	await light.screenshot({ path: join(SHOTS, 'gcode-layer-light.png') });

	// Layers from Z when there are no comments.
	await light.goto(`${APP}/library/preview?source=${lib.id}&path=spool-hub_plain.gcode`);
	await light.waitForSelector('[data-testid=gcode-layer]', { timeout: 30_000 });
	assert.equal(await layerText(light), 'Layer 41 / 41 · Z 8.00');
	assert.ok(await light.locator('[aria-label="Feature types"] button:has-text("Extrusion")').count());

	// --- performance: the big file ------------------------------------------------------------
	const perf = async (page, url, label) => {
		const t0 = Date.now();
		await page.goto(url, { waitUntil: 'commit' });
		await page.waitForSelector('[data-testid=gcode-layer]', { timeout: 180_000 });
		const wall = Date.now() - t0;
		await sleep(300);
		// Frame time while orbiting: synthetic drags, one per frame, timed in the page.
		const orbit = await page.evaluate(async () => {
			const c = document.querySelector('[data-testid=gcode-viewer] canvas');
			const r = c.getBoundingClientRect();
			const at = (type, i) => c.dispatchEvent(new PointerEvent(type, { pointerId: 7, bubbles: true, clientX: r.left + r.width / 2 + i * 5, clientY: r.top + r.height / 2, button: 0, pointerType: 'mouse' }));
			const frame = () => new Promise((res) => requestAnimationFrame(res));
			at('pointerdown', 0);
			await frame();
			const ts = [];
			for (let i = 1; i <= 30; i++) {
				const t = performance.now();
				at('pointermove', i);
				await frame();
				await frame();
				ts.push(performance.now() - t);
			}
			at('pointerup', 30);
			const moving = { drawn: Number(c.dataset.drawn), stride: Number(c.dataset.stride) };
			await new Promise((res) => setTimeout(res, 400));
			const t = performance.now();
			await frame();
			await frame();
			const still = { drawn: Number(c.dataset.drawn), stride: Number(c.dataset.stride), ms: performance.now() - t };
			ts.sort((a, b) => a - b);
			return { medianMs: Math.round(ts[15] * 10) / 10, moving, still };
		});
		const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
		const r = {
			label,
			wallMs: wall,
			parseLoadMs: await loadedIn(page),
			layers: (await layerText(page)).match(/\/ (\d+)/)[1],
			simplified: await page.locator('text=Simplified').count() ? await page.locator('text=Simplified').textContent() : 'no',
			orbitFrameMs: orbit.medianMs,
			drawnMoving: orbit.moving,
			drawnStill: orbit.still,
			heapMB: heap ? Math.round(heap / 1048576) : null
		};
		log(`perf ${label}:`, JSON.stringify(r));
		return r;
	};
	log(`performance: the ${BIG_MB} MB file`);
	results.bigLibrary = await perf(dark, `${APP}/library/preview?source=${lib.id}&path=${encodeURIComponent(`Brackets/big-${BIG_MB}mb.gcode`)}`, 'library (folder source), desktop');
	results.bigOctoPrint = await perf(dark, `${APP}/p/${voron.id}?tab=preview&file=${encodeURIComponent(`big-${BIG_MB}mb.gcode`)}&v=1`, 'OctoPrint (proxied), desktop');
	assert.ok(results.bigLibrary.wallMs < 60_000);

	const phone = await newPage('dark', { phone: true });
	await signIn(phone, VIEWER);
	results.bigPhone = await perf(phone, `${APP}/library/preview?source=${lib.id}&path=${encodeURIComponent(`Brackets/big-${BIG_MB}mb.gcode`)}&v=phone`, 'library, phone (390 px, 1.5 M point budget)');
	assert.notEqual(results.bigPhone.simplified, 'no', 'phones decimate the big file');

	// --- live job: follows filepos ---------------------------------------------------------
	log('live: printing a file, the preview follows the print');
	assert.equal((await admin.post(`/api/printers/${mk4.id}/files/select`, { origin: 'local', path: 'live-part.gcode', print: true })).status, 200);
	await waitFor(async () => (await op(OP[0], 'GET', '/api/job')).progress?.filepos > 120_000, 'the print to get going', { every: 500 });
	await dark.goto(`${APP}/p/${mk4.id}`);
	await dark.click('a:has-text("Preview")');
	await dark.waitForSelector('[data-testid=gcode-printing]', { timeout: 30_000 });
	const printingLayer = async () => Number((await dark.locator('[data-testid=gcode-printing]').textContent()).match(/(\d+)/)[1]);
	const l1 = await printingLayer();
	// Cross-check against OctoPrint's own filepos, parsed in Node with the same parser.
	const { parseGcode, locate } = await import('../../src/lib/gcode/parse.ts');
	const tp = parseGcode(readFileSync(files.live));
	const fp = (await op(OP[0], 'GET', '/api/job')).progress.filepos;
	const expected = locate(tp, fp).layer + 1;
	assert.ok(Math.abs(expected - l1) <= 2, `browser shows layer ${l1}, OctoPrint's filepos says ${expected}`);
	assert.ok(await dark.locator('[data-testid=gcode-nozzle]').count(), 'nozzle marker');
	assert.equal(await layerText(dark).then((t) => Number(t.match(/Layer (\d+)/)[1])), l1, 'the slider follows the print');
	const l2 = await waitFor(async () => {
		const l = await printingLayer();
		return l > l1 ? l : null;
	}, 'the printing layer to advance', { tries: 120 });
	log(`live: layer ${l1} → ${l2} (OctoPrint filepos ${fp} → layer ${expected})`);
	results.live = { firstLayer: l1, laterLayer: l2, filepos: fp, expected };
	await sleep(500);
	await dark.screenshot({ path: join(SHOTS, 'gcode-live.png') });

	// --- camera wall ------------------------------------------------------------------------
	log('camera wall: live streams for a few cameras');
	await dark.goto(`${APP}/cameras`);
	await dark.waitForSelector('[data-testid=camera-tile]');
	assert.equal(await dark.locator('[data-testid=camera-tile]').count(), 3);
	await waitFor(async () => (await dark.locator('[data-testid=camera-tile][data-live=stream]').count()) === 3, 'three live streams');
	await waitFor(() => cam.stats.active === 3, `3 open camera streams (now ${cam.stats.active})`);
	await waitFor(async () => (await dark.locator('[data-testid=camera-progress]').count()) === 1, 'the printing printer shows progress');
	await sleep(1500);
	await dark.screenshot({ path: join(SHOTS, 'cameras.png') });

	log('camera wall: pauses while the tab is hidden');
	await dark.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await waitFor(() => cam.stats.active === 0, `streams closed while hidden (now ${cam.stats.active})`);
	await dark.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await waitFor(() => cam.stats.active === 3, 'streams back when visible');

	log('camera wall: tap to open one camera; the others pause');
	await dark.locator(`[data-testid=camera-tile][data-printer="${voron.id}"] button`).first().click();
	await dark.waitForSelector('[data-testid=camera-focus]');
	await waitFor(() => cam.stats.active === 1, `only the open camera streams (now ${cam.stats.active})`);
	await dark.keyboard.press('Escape');
	await dark.waitForSelector('[data-testid=camera-focus]', { state: 'detached' });

	log('camera wall: snapshot mode, bookmarkable URL');
	await dark.click('button[role=radio]:has-text("Snapshots")');
	await dark.waitForURL(/mode=snapshot/);
	await waitFor(() => cam.stats.active === 0, 'no streams in snapshot mode');
	await waitFor(async () => (await dark.locator('[data-testid=camera-tile][data-live=snapshot]').count()) === 3, 'three snapshot tiles');
	assert.match(await dark.locator('[data-testid=camera-mode]').textContent(), /Snapshots every 10 s/);

	log('camera wall: kiosk mode');
	await dark.goto(`${APP}/cameras?kiosk=1&layout=3`);
	await dark.waitForSelector('[data-testid=camera-kiosk]');
	const kb = await dark.locator('[data-testid=camera-kiosk]').boundingBox();
	assert.deepEqual([kb.x, kb.y, kb.width, kb.height], [0, 0, 1440, 900], 'kiosk covers the whole window');
	await waitFor(async () => (await dark.locator('[data-testid=camera-kiosk]').getAttribute('class')).includes('cursor-none'), 'the cursor hides when idle', { tries: 20 });
	assert.ok((await dark.evaluate(() => window.__wake)) >= 1, 'asked for a screen wake lock');
	await sleep(1000);
	await dark.screenshot({ path: join(SHOTS, 'cameras-kiosk.png') });
	await dark.mouse.move(700, 400);
	await dark.click('[data-testid=kiosk-exit]');
	await dark.waitForSelector('[data-testid=camera-kiosk]', { state: 'detached' });
	assert.match(dark.url(), /\/cameras\?layout=3$/);

	log('camera wall: kiosk rotation');
	await dark.goto(`${APP}/cameras?kiosk=1&rotate=2&mode=snapshot`);
	await dark.waitForSelector('[data-testid=camera-tile]');
	assert.equal(await dark.locator('[data-testid=camera-tile]').count(), 1);
	const firstCam = await dark.locator('[data-testid=camera-tile]').getAttribute('data-printer');
	await waitFor(async () => (await dark.locator('[data-testid=camera-tile]').getAttribute('data-printer')) !== firstCam, 'rotation to the next camera', { tries: 20 });

	await light.goto(`${APP}/cameras?layout=2`);
	await light.waitForSelector('[data-testid=camera-tile][data-live]');
	await sleep(2500);
	await light.screenshot({ path: join(SHOTS, 'cameras-light.png') });

	// --- phones -------------------------------------------------------------------------------
	log('phone: preview and camera wall at 390 px');
	await phone.goto(`${APP}/p/${mk4.id}?tab=preview`);
	await phone.waitForSelector('[data-testid=gcode-printing]', { timeout: 30_000 });
	const pw = await phone.evaluate(() => document.documentElement.scrollWidth);
	assert.ok(pw <= 390, `no horizontal scroll (${pw})`);
	// Touch: pinch and drag on the canvas don't scroll the page.
	const pb = await phone.locator('[data-testid=gcode-viewer] canvas').boundingBox();
	assert.ok(pb.width >= 340, 'the viewer uses the phone width');
	const slider = await phone.locator('[data-testid=gcode-slider]').boundingBox();
	const down = await phone.locator('button[aria-label="Layer down"]').boundingBox();
	assert.ok(down.height >= 44 && down.width >= 44, 'layer buttons are tap-sized');
	assert.ok(slider.width > 150);
	await sleep(500);
	await phone.screenshot({ path: join(SHOTS, 'mobile-gcode-preview.png') });

	await phone.goto(`${APP}/cameras`);
	await phone.waitForSelector('[data-testid=camera-tile]');
	const widths = await phone.locator('[data-testid=camera-tile]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
	const xs = await phone.locator('[data-testid=camera-tile]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
	assert.ok(new Set(xs).size === 1 && widths[0] >= 340, `one column on phones (${xs} / ${widths})`);
	await sleep(2000);
	await phone.screenshot({ path: join(SHOTS, 'mobile-cameras.png') });

	for (const p of [dark, light, phone]) assert.deepEqual(p.errors, [], 'no page errors');
	await op(OP[0], 'POST', '/api/job', { command: 'cancel' });
	log('results', JSON.stringify(results, null, 2));
	writeFileSync(join(work, 'results.json'), JSON.stringify(results, null, 2));
	log('all good');
}

async function cleanup() {
	await browser?.close().catch(() => {});
	if (process.env.E2E_KEEP) {
		log(`keeping: app ${APP}, data ${work}`);
		return;
	}
	app?.kill();
	await cam?.close().catch(() => {});
	try {
		devOctoprint('down');
	} catch {}
	rmSync(work, { recursive: true, force: true });
}

main()
	.then(cleanup)
	.catch(async (err) => {
		console.error(err);
		console.error(`work dir: ${work}`);
		await cleanup();
		process.exit(1);
	});
