// End-to-end test of Discover against real OctoPrint servers (virtual printers in Docker).
//
//   pnpm e2e:discover                  # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:discover       # leave the containers, mocks and app running
//   E2E_SKIP_BUILD=1 pnpm e2e:discover # reuse ./build
//
// Three OctoPrint containers listen on 127.0.0.1:5151-5153. Discover finds them through a
// mock Docker API (fictional container names, devices and networks pointing at the real
// ports), a mock Arcane API, a unicast mDNS responder, the real local Docker socket
// (read-only GETs), and a subnet scan of 127.0.0.1. Keys come through OctoPrint's
// Application Keys flow, approved by logging in to OctoPrint's API as its admin.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startForwarder, startMdnsResponder, startMockArcane, startMockDocker } from './mock-discovery.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3170);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_BASE = Number(process.env.E2E_OP_PORT_BASE ?? 5151);
const OP_PREFIX = 'octo-modern-disc-op';
const MOCK_BASE = Number(process.env.E2E_MOCK_PORT_BASE ?? 5251);
const DOCKER_PORT = MOCK_BASE;
const ARCANE_PORT = MOCK_BASE + 1;
const MDNS_PORT = MOCK_BASE + 2;
const FORWARD_PORT = MOCK_BASE + 3;
const ARCANE_KEY = 'arc_e2e_read_only_key';
const OP = [1, 2, 3].map((i) => ({ url: `http://127.0.0.1:${OP_BASE + i - 1}`, port: OP_BASE + i - 1, key: `ocm-dev-key-${i}` }));
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OP_ADMIN = { user: 'admin', pass: 'octoprint-dev' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const opEnv = { ...process.env, OCM_OP_PORT_BASE: String(OP_BASE), OCM_OP_PREFIX: OP_PREFIX, OCM_OP_CONNECT: '0' };
const devOctoprint = (...args) => execFileSync(join(ROOT, 'scripts/dev-octoprint.sh'), args, { env: opEnv, stdio: 'inherit' });

let app;
let browser;
const mocks = [];
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-e2e-discover-'));

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

/** A tiny cookie-keeping JSON client for octo·modern. */
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
	return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p, {}) };
}

/**
 * Decides a pending Application Keys request in OctoPrint, as its admin would in the
 * approval dialog: log in (session + CSRF cookie), find the pending request, POST the decision.
 */
async function decideInOctoPrint(op, decision) {
	const jar = new Map();
	const keep = (res) => {
		for (const c of res.headers.getSetCookie()) {
			const [kv] = c.split(';');
			const i = kv.indexOf('=');
			jar.set(kv.slice(0, i), kv.slice(i + 1));
		}
	};
	const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
	const csrf = () => [...jar].find(([k]) => k.startsWith('csrf_token'))?.[1] ?? '';
	keep(await fetch(`${op.url}/`, { redirect: 'manual' }));
	const login = await fetch(`${op.url}/api/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrf(), cookie: cookie() },
		body: JSON.stringify({ ...OP_ADMIN, remember: false })
	});
	assert.equal(login.status, 200, `OctoPrint login: ${await login.clone().text()}`);
	keep(login);
	const token = await waitFor(async () => {
		const r = await fetch(`${op.url}/api/plugin/appkeys`, { headers: { cookie: cookie() } });
		const pending = Object.values((await r.json()).pending ?? {});
		return pending.find((p) => p.app_id === 'octo·modern')?.user_token;
	}, 'a pending key request in OctoPrint');
	const res = await fetch(`${op.url}/plugin/appkeys/decision/${token}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrf(), cookie: cookie() },
		body: JSON.stringify({ decision })
	});
	assert.equal(res.status, 204, `OctoPrint decision: ${await res.text()}`);
}

function dockerSocket() {
	if (process.env.DOCKER_HOST?.startsWith('unix://')) return process.env.DOCKER_HOST;
	const found = ['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock'), join(homedir(), '.orbstack/run/docker.sock')].find((p) => existsSync(p));
	return found && `unix://${found}`;
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	log('starting three OctoPrint servers');
	devOctoprint('up', '3');

	const ports = { mk4: OP[0].port, ender3: OP[1].port, voron: OP[2].port };
	const docker = await startMockDocker({ port: DOCKER_PORT, ports });
	mocks.push(docker, await startMockArcane({ port: ARCANE_PORT, apiKey: ARCANE_KEY, voronPort: OP[2].port }));
	const mdns = await startMdnsResponder({ port: MDNS_PORT, instance: 'OctoPrint instance on voron', target: 'voron.local', ip: '127.0.0.1', servicePort: OP[2].port, version: '1.11.8' });
	mocks.push(mdns);
	log(`mock Docker API on :${DOCKER_PORT}, Arcane on :${ARCANE_PORT}, mDNS responder on udp :${MDNS_PORT}`);

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
			OCM_DOCKER_HOSTS: `tcp://127.0.0.1:${DOCKER_PORT}`,
			OCM_SELF_CONTAINER: 'octo-modern',
			OCM_MDNS_TARGET: `127.0.0.1:${MDNS_PORT}`,
			NODE_OPTIONS: '--disable-warning=ExperimentalWarning'
		}
	});
	let appLog = '';
	app.stdout.on('data', (d) => (appLog += d));
	app.stderr.on('data', (d) => (appLog += d));
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');

	browser = await chromium.launch();
	const shot = async (page, name) => {
		await page.waitForTimeout(400); // let tab and dialog transitions finish
		await page.screenshot({ path: join(SHOTS, `${name}.png`) });
		log(`  screenshot ${name}.png`);
	};
	const newPage = async (theme) => {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
		await ctx.addInitScript((t) => localStorage.setItem('ocm-theme', t), theme);
		const page = await ctx.newPage();
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
		page.errors = errors;
		return page;
	};

	// --- setup wizard: create the admin, then add a discovered printer -----------------
	log('setup wizard: discovered printers and the Application Keys flow');
	const wiz = await newPage('dark');
	await wiz.goto(`${APP}/setup`);
	await wiz.waitForLoadState('networkidle');
	await wiz.fill('#s-name', ADMIN.name);
	await wiz.fill('#s-email', ADMIN.email);
	await wiz.fill('#s-pw', ADMIN.password);
	await wiz.fill('#s-pw2', ADMIN.password);
	await wiz.click('button:has-text("Create account")');
	await wiz.waitForSelector('text=Found on this host and network');
	await wiz.waitForSelector('text=octoprint-mk4');
	await wiz.waitForSelector('text=Look again');
	await shot(wiz, 'setup-discover');
	await wiz.click('[data-candidate="octoprint-mk4"] button:has-text("Add")');
	await wiz.click('button:has-text("Request a key")');
	await wiz.waitForSelector('text=Waiting for approval in OctoPrint');
	const approveHref = await wiz.locator('a:has-text("Approve in OctoPrint")').getAttribute('href');
	assert.match(approveHref, new RegExp(`^http://127\\.0\\.0\\.1:${OP[0].port}/plugin/appkeys/auth/`), 'the approval link opens OctoPrint’s own dialog');
	await shot(wiz, 'discover-approve');
	await decideInOctoPrint(OP[0], true);
	await wiz.waitForSelector("text=You're set up", { timeout: 20_000 });
	assert.deepEqual(wiz.errors, [], 'no browser errors in the wizard');

	const admin = client();
	assert.equal((await admin.post('/api/auth/login', { email: ADMIN.email, password: ADMIN.password })).status, 200);
	const saved = (await admin.get('/api/printers')).data;
	assert.equal(saved.length, 1);
	assert.equal(saved[0].name, 'octoprint-mk4');
	assert.equal(saved[0].baseUrl, OP[0].url);
	assert.ok(saved[0].hasApiKey && !JSON.stringify(saved[0]).includes('ocm-dev-key'), 'the approved key is stored, not sent back');
	await waitFor(async () => (await admin.get(`/api/printers/${saved[0].id}/state`)).status === 200, 'the imported printer answering through octo·modern');

	// --- Docker (mock API) --------------------------------------------------------------
	log('Docker scan through the mock Docker API');
	let scan = (await admin.get('/api/discover/docker')).data;
	assert.equal(scan.length, 1);
	assert.equal(scan[0].error, undefined);
	assert.equal(scan[0].inspected, 8);
	const byName = Object.fromEntries(scan[0].candidates.map((c) => [c.name, c]));
	assert.deepEqual(Object.keys(byName).sort(), ['octoprint-bambu', 'octoprint-ender3', 'octoprint-garage', 'octoprint-mk4', 'octoprint-voron'], 'OctoPrint only; obico, nginx and octo·modern itself are skipped');
	assert.equal(byName['octoprint-mk4'].saved?.id, saved[0].id, 'the printer added in the wizard is marked saved');
	assert.equal(byName['octoprint-mk4'].saved.addressChanged, false);
	assert.equal(byName['octoprint-ender3'].reachable, true);
	assert.equal(byName['octoprint-ender3'].baseUrl, OP[1].url);
	assert.equal(byName['octoprint-ender3'].fingerprint.confidence, 'confirmed');
	assert.equal(byName['octoprint-ender3'].fingerprint.appkeys, true);
	assert.equal(byName['octoprint-ender3'].fingerprint.version, '1.11.8');
	assert.deepEqual(byName['octoprint-ender3'].serial, [{ host: '/dev/ttyUSB0', container: '/dev/ttyUSB0', via: 'device' }]);
	assert.equal(byName['octoprint-ender3'].network.via, 'shared-network', 'octo·modern’s own container shares printers_default');
	assert.deepEqual(byName['octoprint-voron'].serial, [{ host: '/dev/ttyACM1', container: '/dev/ttyACM0', via: 'bind' }]);
	assert.equal(byName['octoprint-voron'].network.via, 'published-port');
	assert.equal(byName['octoprint-garage'].reachable, false);
	assert.equal(byName['octoprint-garage'].network.via, 'none');
	assert.equal(byName['octoprint-garage'].network.join, 'garage_default');
	assert.equal(byName['octoprint-bambu'].container.state, 'exited');
	assert.equal(byName['octoprint-bambu'].network, undefined);
	assert.ok(docker.requests.every((r) => r.startsWith('GET ')), 'only GETs reach the Docker API');

	// --- the real local Docker socket (read-only GETs) ----------------------------------
	const socket = dockerSocket();
	if (socket) {
		log(`Docker scan through the real socket (${socket})`);
		assert.equal((await admin.put('/api/discover/settings', { dockerHosts: [socket] })).status, 200);
		scan = (await admin.get('/api/discover/docker')).data;
		const real = scan.find((s) => s.endpoint === socket);
		assert.equal(real.error, undefined, real.error);
		for (const op of OP) {
			const c = real.candidates.find((x) => x.baseUrl === op.url);
			assert.ok(c, `found the container serving ${op.url}`);
			assert.match(c.name, new RegExp(`^${OP_PREFIX}\\d$`));
			assert.equal(c.reachable, true);
			assert.equal(c.fingerprint.confidence, 'confirmed');
		}
		assert.equal(real.candidates.find((c) => c.baseUrl === OP[0].url).saved?.id, saved[0].id, 'saved matching by address across sources');
		assert.equal((await admin.put('/api/discover/settings', { dockerHosts: [] })).status, 200);
	}

	// --- Arcane (mock API) ----------------------------------------------------------------
	log('Arcane');
	const badKey = await admin.post('/api/discover/arcane/managers', { name: 'Arcane', url: `http://127.0.0.1:${ARCANE_PORT}`, apiKey: 'nope' });
	assert.equal(badKey.status, 400);
	assert.match(badKey.data.message, /rejected the API key/);
	assert.equal((await admin.post('/api/discover/arcane/managers', { name: 'Arcane', url: `http://127.0.0.1:${ARCANE_PORT}/`, apiKey: ARCANE_KEY })).status, 200);
	const arcane = (await admin.get('/api/discover/arcane')).data;
	assert.equal(arcane[0].error, undefined);
	const [local, garage] = arcane[0].environments;
	assert.deepEqual(local.candidates.map((c) => [c.name, c.baseUrl, c.reachable]), [['octoprint-voron', OP[2].url, true]]);
	assert.deepEqual(local.candidates[0].serial.map((s) => s.host), ['/dev/ttyACM1'], 'devices from the container detail');
	assert.deepEqual(garage.candidates.map((c) => [c.name, c.reachable]), [['octopi-ender5', false]]);
	assert.deepEqual(garage.candidates[0].serial.map((s) => s.host), ['/dev/ttyUSB0']);

	// --- mDNS (unicast responder) and the subnet scan -------------------------------------
	log('mDNS and subnet scan');
	const md = (await admin.post('/api/discover/mdns')).data;
	assert.ok(mdns.queries() > 0, 'the responder was asked');
	assert.deepEqual(md.candidates.map((c) => [c.name, c.baseUrl, c.fingerprint.version]), [['voron', OP[2].url, '1.11.8']]);
	const sub = await admin.post('/api/discover/subnet', { targets: '127.0.0.1', ports: `${OP_BASE}-${OP_BASE + 2}, ${DOCKER_PORT}` });
	assert.equal(sub.status, 200, JSON.stringify(sub.data));
	assert.equal(sub.data.probed, 4);
	assert.deepEqual(sub.data.candidates.map((c) => c.baseUrl), OP.map((o) => o.url), 'three OctoPrints; the mock Docker API is not one');
	assert.equal(sub.data.candidates[0].saved?.id, saved[0].id);
	assert.equal((await admin.post('/api/discover/subnet', { targets: '10.0.0.0/8', ports: '80' })).status, 400, 'oversized ranges are refused');

	// --- screenshots of Discover ---------------------------------------------------------
	log('Discover screenshots');
	const signIn = async (page) => {
		await page.goto(`${APP}/login`);
		await page.waitForLoadState('networkidle');
		await page.fill('#email', ADMIN.email);
		await page.fill('#pw', ADMIN.password);
		await page.click('button:has-text("Sign in")');
		await page.waitForURL((u) => !u.pathname.startsWith('/login'));
	};
	const pages = [];
	for (const theme of ['dark', 'light']) {
		const p = await newPage(theme);
		pages.push(p);
		await signIn(p);
		await p.goto(`${APP}/discover`);
		await p.waitForSelector('text=octoprint-ender3');
		await p.waitForLoadState('networkidle');
		await shot(p, theme === 'dark' ? 'discover' : 'discover-light');
	}
	const dark = pages[0];
	await dark.click('[role=tab]:has-text("Network")');
	await dark.fill('#sn-targets', '127.0.0.1');
	await dark.fill('#sn-ports', `${OP_BASE}-${OP_BASE + 2}`);
	await dark.getByRole('button', { name: 'Scan', exact: true }).click();
	await dark.waitForSelector('text=Probed 3 address/port pairs');
	await shot(dark, 'discover-network');
	await dark.click('[role=tab]:has-text("Arcane")');
	await dark.waitForSelector('text=octopi-ender5');
	await shot(dark, 'discover-arcane');

	// --- Application Keys through the API: approve, deny, paste --------------------------
	log('Application Keys: approved, denied, pasted');
	const ender = byName['octoprint-ender3'];
	let req = (await admin.post('/api/discover/appkey', { baseUrl: ender.baseUrl })).data;
	assert.equal(req.state, 'pending');
	assert.ok(!('apiKey' in req));
	await decideInOctoPrint(OP[1], true);
	req = await waitFor(async () => {
		const s = (await admin.get(`/api/discover/appkey/${req.id}`)).data;
		return s.state !== 'pending' && s;
	}, 'the approval');
	assert.equal(req.state, 'approved');
	assert.ok(!JSON.stringify(req).match(/api_?key/i), 'the key never reaches the browser');
	assert.equal((await admin.post('/api/discover/import', { appKeyRequest: req.id, baseUrl: 'http://127.0.0.1:9', name: 'x' })).status, 400, 'an approved key only imports for its own address');
	const imported = await admin.post('/api/discover/import', { appKeyRequest: req.id, key: ender.key, baseUrl: ender.baseUrl, name: 'Ender 3' });
	assert.equal(imported.status, 201, JSON.stringify(imported.data));
	assert.equal(imported.data.test.ok, true);
	assert.equal(imported.data.test.user, 'admin');
	assert.deepEqual(imported.data.test.missing, []);
	assert.equal((await admin.post('/api/discover/import', { appKeyRequest: req.id, baseUrl: ender.baseUrl, name: 'again' })).status, 400, 'a request is used once');

	let denied = (await admin.post('/api/discover/appkey', { baseUrl: OP[2].url })).data;
	await decideInOctoPrint(OP[2], false);
	denied = await waitFor(async () => {
		const s = (await admin.get(`/api/discover/appkey/${denied.id}`)).data;
		return s.state !== 'pending' && s;
	}, 'the denial');
	assert.equal(denied.state, 'denied');
	assert.equal((await admin.post('/api/discover/import', { appKeyRequest: denied.id, baseUrl: OP[2].url, name: 'Voron' })).status, 400);

	const wrong = await admin.post('/api/discover/import', { apiKey: 'definitely-not-a-key', baseUrl: OP[2].url, name: 'Voron' });
	assert.equal(wrong.status, 422, 'a failing test is not saved');
	assert.equal(wrong.data.test.error.code, 'HTTP_403');
	const voron = byName['octoprint-voron'];
	const pasted = await admin.post('/api/discover/import', { apiKey: OP[2].key, key: voron.key, baseUrl: OP[2].url, name: 'Voron 2.4' });
	assert.equal(pasted.status, 201);
	assert.equal((await admin.get('/api/printers')).data.length, 3);

	// --- a container's port moves: "address changed" and relink --------------------------
	log('address changed → relink');
	mocks.push(await startForwarder({ port: FORWARD_PORT, to: OP[1].port }));
	ports.ender3 = FORWARD_PORT;
	scan = (await admin.get('/api/discover/docker')).data;
	const moved = scan[0].candidates.find((c) => c.name === 'octoprint-ender3');
	assert.equal(moved.baseUrl, `http://127.0.0.1:${FORWARD_PORT}`);
	assert.equal(moved.saved?.id, imported.data.printer.id, 'recognized as the same container');
	assert.equal(moved.saved.addressChanged, true);
	await dark.click('[role=tab]:has-text("Docker")');
	await dark.click('button:has-text("Rescan")');
	await dark.waitForSelector('text=but this scan reaches it elsewhere');
	await dark.locator('text=but this scan reaches it elsewhere').scrollIntoViewIfNeeded();
	await shot(dark, 'discover-moved');
	const relinked = await admin.post('/api/discover/relink', { printerId: moved.saved.id, baseUrl: moved.baseUrl, key: moved.key });
	assert.equal(relinked.status, 200);
	assert.equal(relinked.data.baseUrl, `http://127.0.0.1:${FORWARD_PORT}`);
	assert.equal((await admin.post('/api/printers/test', { id: moved.saved.id, baseUrl: relinked.data.baseUrl })).data.ok, true, 'the stored key works at the new address');
	scan = (await admin.get('/api/discover/docker')).data;
	assert.equal(scan[0].candidates.find((c) => c.name === 'octoprint-ender3').saved.addressChanged, false);

	// --- access ---------------------------------------------------------------------------
	assert.equal((await admin.post('/api/users', { email: 'viewer@example.com', role: 'viewer', password: 'viewer-password' })).status, 201);
	const viewer = client();
	assert.equal((await viewer.post('/api/auth/login', { email: 'viewer@example.com', password: 'viewer-password' })).status, 200);
	for (const [m, p] of [['get', '/api/discover/docker'], ['post', '/api/discover/subnet'], ['post', '/api/discover/appkey'], ['post', '/api/discover/import']]) {
		assert.equal((await viewer[m](p, {})).status, 403, `viewers can't ${m} ${p}`);
	}

	for (const p of pages) assert.deepEqual(p.errors, [], 'no browser errors');
	log('all discovery e2e checks passed');
	writeFileSync(join(dataDir, 'app.log'), appLog);
}

async function cleanup() {
	await browser?.close().catch(() => {});
	if (process.env.E2E_KEEP) {
		log(`E2E_KEEP: app still running on ${APP} (pid ${app?.pid}), data in ${dataDir}`);
		return;
	}
	for (const m of mocks) await m.close().catch(() => {});
	app?.kill();
	try {
		devOctoprint('down');
	} catch {}
	rmSync(dataDir, { recursive: true, force: true });
}

try {
	await main();
	await cleanup();
	process.exit(0);
} catch (err) {
	console.error('✗ discovery e2e failed:', err);
	await cleanup();
	process.exit(1);
}
