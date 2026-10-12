import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-devices-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-devices';
// origin.ts reads import.meta.env (Vite) unless ORIGIN is set.
process.env.ORIGIN = 'http://ocm.local';
const dev = await import('../src/lib/server/devices.ts');
const store = await import('../src/lib/server/store.ts');
const { SESSION_COOKIE } = await import('../src/lib/server/auth.ts');
const { sha256 } = await import('../src/lib/server/crypto.ts');
const { handle } = await import('../src/hooks.server.ts');
const devicesRoute = await import('../src/routes/api/account/devices/+server.ts');
const deviceRoute = await import('../src/routes/api/account/devices/[id]/+server.ts');
const currentRoute = await import('../src/routes/api/account/devices/current/+server.ts');
const health = await import('../src/routes/api/health/+server.ts');

// --- a tiny request runner: hooks.server.ts in front of the device routes -----------------

type Fn = (event: unknown) => Promise<Response> | Response;
const ROUTES: { re: RegExp; mod: Record<string, Fn> }[] = [
	{ re: /^\/api\/account\/devices$/, mod: devicesRoute as unknown as Record<string, Fn> },
	{ re: /^\/api\/account\/devices\/current$/, mod: currentRoute as unknown as Record<string, Fn> },
	{ re: /^\/api\/account\/devices\/(?<id>[^/]+)$/, mod: deviceRoute as unknown as Record<string, Fn> },
	{ re: /^\/api\/health$/, mod: health as unknown as Record<string, Fn> }
];

/** Routes the hook let through but this runner doesn't serve answer 299, so tests can tell "allowed" from "refused". */
const PASSED = 299;

async function call(method: string, path: string, opts: { bearer?: string; session?: string; body?: unknown; ip?: string } = {}) {
	const url = new URL(`http://ocm.local${path}`);
	const headers = new Headers();
	if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
	if (opts.body !== undefined) headers.set('content-type', 'application/json');
	const request = new Request(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
	const cookies = { get: (n: string) => (n === SESSION_COOKIE ? opts.session : undefined), set() {}, delete() {} };
	const event = { url, request, cookies, locals: {} as App.Locals, params: {} as Record<string, string>, getClientAddress: () => opts.ip ?? '10.0.0.5' };
	const resolve = async (e: typeof event) => {
		for (const r of ROUTES) {
			const m = r.re.exec(url.pathname);
			if (!m) continue;
			e.params = { ...(m.groups ?? {}) };
			const fn = r.mod[method];
			if (!fn) return new Response(null, { status: 405 });
			return fn(e);
		}
		return new Response(JSON.stringify({ passed: true, user: e.locals.user?.email, device: e.locals.device?.name }), { status: PASSED });
	};
	try {
		const res = await (handle as unknown as (i: { event: typeof event; resolve: typeof resolve }) => Promise<Response>)({ event, resolve });
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	} catch (err) {
		// SvelteKit redirects are thrown.
		const r = err as { status?: number; location?: string };
		return { status: r.status ?? 500, body: { location: r.location } };
	}
}

function session(userId: string): string {
	const token = `session-${userId}-${Math.random()}`;
	store.createSession(sha256(token), userId, 60_000);
	return token;
}

const admin = store.createUser({ email: 'admin@x.io', role: 'admin' });
const operator = store.createUser({ email: 'op@x.io', role: 'operator' });
const viewer = store.createUser({ email: 'viewer@x.io', role: 'viewer' });
const printerA = store.createPrinter({ name: 'MK4', kind: 'octoprint', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', verifyTls: true, webcamUrl: null, color: 'violet' } as Parameters<typeof store.createPrinter>[0]);
const printerB = store.createPrinter({ name: 'Voron', kind: 'octoprint', baseUrl: 'http://127.0.0.1:2', apiKey: 'k', verifyTls: true, webcamUrl: null, color: 'blue' } as Parameters<typeof store.createPrinter>[0]);

test('health says it is octo·modern, for the app’s server check', async () => {
	const r = await call('GET', '/api/health');
	assert.equal(r.status, 200);
	assert.deepEqual(r.body, { ok: true, app: 'octo-modern' });
});

test('a signed-in session links a device; the token is shown once and only its hash is kept', async () => {
	const s = session(operator.id);
	const r = await call('POST', '/api/account/devices', { session: s, body: { name: '  Pixel   8 ', platform: 'android' } });
	assert.equal(r.status, 201);
	assert.match(r.body.token, /^ocd_[A-Za-z0-9_-]{43}$/);
	assert.equal(r.body.device.name, 'Pixel 8');
	assert.ok(r.body.token.startsWith(r.body.device.prefix));
	const row = store.sqlite().prepare('SELECT * FROM device_tokens WHERE id = ?').get(r.body.device.id) as Record<string, unknown>;
	assert.equal(row.token_hash, createHash('sha256').update(r.body.token).digest('hex'));
	assert.ok(!JSON.stringify(row).includes(r.body.token));
	assert.equal(row.user_id, operator.id);
	const audit = store.sqlite().prepare(`SELECT * FROM audit WHERE action = 'device.link'`).all() as Record<string, unknown>[];
	assert.ok(audit.some((a) => a.user_email === 'op@x.io' && a.detail === 'Pixel 8'));

	const list = await call('GET', '/api/account/devices', { session: s });
	assert.equal(list.status, 200);
	assert.deepEqual(list.body.map((d: { name: string }) => d.name), ['Pixel 8']);
	assert.ok(!JSON.stringify(list.body).includes('hash'));
});

test('linking needs a session: not anonymous, not another device token, valid input', async () => {
	assert.equal((await call('POST', '/api/account/devices', { body: { name: 'x' } })).status, 401);
	const s = session(viewer.id);
	assert.equal((await call('POST', '/api/account/devices', { session: s, body: { name: '' } })).status, 400);
	assert.equal((await call('POST', '/api/account/devices', { session: s, body: { name: 'x'.repeat(81) } })).status, 400);
	assert.equal((await call('POST', '/api/account/devices', { session: s, body: { name: 'x', platform: 'ios' } })).status, 400);
	const { token } = dev.createDevice(viewer, { name: 'Tablet', platform: 'android' });
	// A device token can't mint more tokens (the route isn't open to it at all).
	assert.equal((await call('POST', '/api/account/devices', { bearer: token, body: { name: 'y' } })).status, 403);
	assert.equal((await call('GET', '/api/account/devices', { bearer: token })).status, 403);
});

test('a device token acts as its user, on the app’s routes only', async () => {
	const { token } = dev.createDevice(operator, { name: 'Phone', platform: 'android' });
	for (const [m, p] of [
		['GET', '/api/printers'],
		['GET', '/api/printers/status'],
		['GET', `/api/printers/${printerA.id}/state`],
		['GET', `/api/printers/${printerA.id}/webcam/snapshot`]
	]) {
		const r = await call(m, p, { bearer: token });
		assert.equal(r.status, PASSED, `${m} ${p}`);
		assert.equal(r.body.user, 'op@x.io');
		assert.equal(r.body.device, 'Phone');
	}
	for (const [m, p] of [
		['GET', '/api/settings'],
		['GET', '/api/users'],
		['GET', '/api/history'],
		['GET', `/api/printers/${printerA.id}/events`],
		['GET', `/api/printers/${printerA.id}/files`],
		['POST', `/api/printers/${printerA.id}/command`],
		['POST', `/api/printers/${printerA.id}/temperature`],
		['DELETE', `/api/printers/${printerA.id}`],
		['PUT', '/api/account'],
		['GET', '/api/integrations/tokens'],
		['POST', '/api/queue']
	]) {
		assert.equal((await call(m, p, { bearer: token })).status, 403, `${m} ${p}`);
	}
	// Pages never take device tokens: the bearer header is ignored and the session rules apply.
	const page = await call('GET', '/settings', { bearer: token });
	assert.equal(page.status, 303);
});

test('job control from a device: pause, resume and cancel only, and only for operators', async () => {
	const op = dev.createDevice(operator, { name: 'Op phone', platform: 'android' }).token;
	for (const command of ['pause', 'resume', 'cancel']) {
		assert.equal((await call('POST', `/api/printers/${printerA.id}/job`, { bearer: op, body: { command } })).status, PASSED, command);
	}
	for (const body of [{ command: 'start' }, { command: 'restart' }, {}, 'junk']) {
		assert.equal((await call('POST', `/api/printers/${printerA.id}/job`, { bearer: op, body })).status, 403, JSON.stringify(body));
	}
	const view = dev.createDevice(viewer, { name: 'Viewer phone', platform: 'android' }).token;
	const r = await call('POST', `/api/printers/${printerA.id}/job`, { bearer: view, body: { command: 'pause' } });
	assert.equal(r.status, 403);
	assert.match(r.body.message, /only watch/);
	assert.equal((await call('GET', '/api/printers/status', { bearer: view })).status, PASSED, 'viewers still watch');
});

test('printer access follows the user’s grants', async () => {
	const limited = store.createUser({ email: 'limited@x.io', role: 'operator' });
	store.setGrants(limited.id, [printerA.id]);
	store.updateUser(limited.id, { printerAccess: 'selected' });
	const { token } = dev.createDevice(limited, { name: 'L', platform: 'android' });
	assert.equal((await call('GET', `/api/printers/${printerA.id}/state`, { bearer: token })).status, PASSED);
	assert.equal((await call('GET', `/api/printers/${printerB.id}/state`, { bearer: token })).status, 404);
	assert.equal((await call('POST', `/api/printers/${printerB.id}/job`, { bearer: token, body: { command: 'pause' } })).status, 404);
});

test('role changes and disabling apply at once; deleted users’ tokens stop working', async () => {
	const u = store.createUser({ email: 'changes@x.io', role: 'operator' });
	const { token } = dev.createDevice(u, { name: 'P', platform: 'android' });
	assert.equal((await call('POST', `/api/printers/${printerA.id}/job`, { bearer: token, body: { command: 'pause' } })).status, PASSED);
	store.updateUser(u.id, { role: 'viewer' });
	assert.equal((await call('POST', `/api/printers/${printerA.id}/job`, { bearer: token, body: { command: 'pause' } })).status, 403);
	store.updateUser(u.id, { disabled: true });
	assert.equal((await call('GET', '/api/printers/status', { bearer: token })).status, 401);
	store.updateUser(u.id, { disabled: false });
	assert.equal((await call('GET', '/api/printers/status', { bearer: token })).status, PASSED);
	store.deleteUser(u.id);
	assert.equal((await call('GET', '/api/printers/status', { bearer: token })).status, 401);
});

test('current: the app checks its token and revokes it when you sign out there', async () => {
	const { token, device } = dev.createDevice(admin, { name: 'Admin phone', platform: 'android' });
	const me = await call('GET', '/api/account/devices/current', { bearer: token });
	assert.equal(me.status, 200);
	assert.equal(me.body.device.id, device.id);
	assert.equal(me.body.device.current, true);
	assert.deepEqual(me.body.user, { name: null, email: 'admin@x.io', role: 'admin' });
	// Admins' device tokens are scoped too.
	assert.equal((await call('GET', '/api/settings', { bearer: token })).status, 403);

	assert.equal((await call('DELETE', '/api/account/devices/current', { bearer: token })).status, 200);
	assert.equal((await call('GET', '/api/account/devices/current', { bearer: token })).status, 401);
	assert.ok(dev.getDevice(device.id)!.revokedAt);
	// Sessions can't use "current".
	assert.equal((await call('GET', '/api/account/devices/current', { session: session(admin.id) })).status, 403);
});

test('My account revokes a device, then forgets it; other users’ devices are out of reach', async () => {
	const s = session(viewer.id);
	const { token, device } = dev.createDevice(viewer, { name: 'Old phone', platform: 'android' });
	const mine = dev.createDevice(operator, { name: 'Not yours', platform: 'android' });
	assert.equal((await call('DELETE', `/api/account/devices/${mine.device.id}`, { session: s })).status, 404);
	assert.equal(dev.getDevice(mine.device.id)!.revokedAt, null);

	const r = await call('DELETE', `/api/account/devices/${device.id}`, { session: s });
	assert.deepEqual(r.body, { ok: true, revoked: true });
	assert.equal((await call('GET', '/api/printers/status', { bearer: token })).status, 401);
	const listed = (await call('GET', '/api/account/devices', { session: s })).body as { id: string; revokedAt: string | null }[];
	assert.ok(listed.find((d) => d.id === device.id)?.revokedAt);
	assert.deepEqual((await call('DELETE', `/api/account/devices/${device.id}`, { session: s })).body, { ok: true, deleted: true });
	assert.equal(dev.getDevice(device.id), undefined);
	// A device token can't revoke other devices by id.
	assert.equal((await call('DELETE', `/api/account/devices/${mine.device.id}`, { bearer: mine.token })).status, 403);
});

test('tokens are only read from the Authorization header, and bad ones are throttled', async () => {
	assert.equal(dev.presentedDeviceToken(new Headers({ authorization: 'Bearer ocd_abc' })), 'ocd_abc');
	assert.equal(dev.presentedDeviceToken(new Headers({ authorization: 'Bearer ocm_abc' })), null);
	assert.equal(dev.presentedDeviceToken(new Headers()), null);
	assert.ok(!dev.looksLikeDeviceToken('ocd_short'));
	dev.resetDeviceThrottle();
	const bad = `ocd_${'A'.repeat(43)}`;
	let last = { status: 0 };
	for (let i = 0; i < 21; i++) last = await call('GET', '/api/printers/status', { bearer: bad, ip: '10.9.9.9' });
	assert.equal(last.status, 429);
	assert.equal((await call('GET', '/api/printers/status', { bearer: bad, ip: '10.9.9.8' })).status, 401);
});

test('route allowlist', () => {
	assert.ok(dev.deviceRouteAllowed('GET', '/api/printers'));
	assert.ok(dev.deviceRouteAllowed('HEAD', '/api/printers/status'));
	assert.ok(dev.deviceRouteAllowed('POST', '/api/printers/a/job'));
	assert.ok(!dev.deviceRouteAllowed('GET', '/api/printers/a/job/x'));
	assert.ok(!dev.deviceRouteAllowed('PUT', '/api/printers/a/job'));
	assert.ok(!dev.deviceRouteAllowed('POST', '/api/printers'));
	assert.ok(!dev.deviceRouteAllowed('GET', '/api/printers/a/webcam/stream'));
	assert.ok(dev.deviceJobCommandAllowed({ command: 'cancel', confirm: true }));
	assert.ok(!dev.deviceJobCommandAllowed({ command: 'start' }));
	assert.ok(!dev.deviceJobCommandAllowed(null));
});

test('active devices per user are capped; old revoked entries are pruned', () => {
	const u = store.createUser({ email: 'many@x.io', role: 'viewer' });
	const ids: string[] = [];
	for (let i = 0; i < dev.MAX_DEVICES_PER_USER; i++) ids.push(dev.createDevice(u, { name: `d${i}`, platform: 'android' }).device.id);
	assert.throws(() => dev.createDevice(u, { name: 'one more', platform: 'android' }), /linked devices/);
	for (const id of ids) dev.revokeDevice(u.id, id);
	dev.createDevice(u, { name: 'fresh', platform: 'android' });
	assert.ok(dev.listDevices(u.id).length <= 11);
});
