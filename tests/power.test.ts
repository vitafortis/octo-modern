import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Local mock devices only (127.0.0.1, ports 3237–3239): no real plug is ever contacted.
// @ts-expect-error plain JS helper shared with the e2e script
import { startMockPlug } from '../scripts/e2e/mock-plugs.mjs';
// @ts-expect-error plain JS helper shared with the e2e script
import { startMockOctoPrint } from '../scripts/e2e/mock-octoprint.mjs';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-power-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-power';
const store = await import('../src/lib/server/store.ts');
const { parseChallenge, digestAuthorization, PlugError } = await import('../src/lib/server/power/http.ts');
const { createAdapter, matches } = await import('../src/lib/server/power/adapters.ts');
const cfg = await import('../src/lib/server/power/config.ts');
const { AutoOff, maxHotend } = await import('../src/lib/server/power/autooff.ts');
const { PowerService } = await import('../src/lib/server/power/service.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const { adminOnlyApi, controlApi } = await import('../src/lib/server/access.ts');
const { formatCountdown, formatEnergy, formatWatts } = await import('../src/lib/power.ts');

const PLUG_PORT = 3237;
const OP_PORT = 3239;
const deps = { timeoutMs: 2_000 };

type Mock = { url: string; state: { on: boolean; requests: { method: string; path: string; headers: Record<string, string>; body: string }[]; failNext: number }; close: () => Promise<void> };
async function withPlug(opts: Record<string, unknown>, fn: (m: Mock) => Promise<void>) {
	const m: Mock = await startMockPlug({ port: PLUG_PORT, ...opts });
	try {
		await fn(m);
	} finally {
		await m.close();
	}
}

// --- digest -----------------------------------------------------------------------------

test('digest: RFC 7616 examples (MD5 and SHA-256)', () => {
	const challenge = parseChallenge('Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"')!;
	assert.equal(challenge.realm, 'http-auth@example.org');
	assert.equal(challenge.qop, 'auth, auth-int');
	const base = { method: 'GET', uri: '/dir/index.html', username: 'Mufasa', password: 'Circle of Life', cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ', nc: 1 };
	const sha = digestAuthorization({ ...base, challenge });
	assert.match(sha, /response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"/);
	assert.match(sha, /qop=auth, nc=00000001/);
	assert.match(sha, /opaque="FQhe/);
	const md5 = digestAuthorization({ ...base, challenge: { ...challenge, algorithm: 'MD5' } });
	assert.match(md5, /response="8ca523f5e9506fed4657c9700eebdbec"/);
	assert.equal(parseChallenge('Basic realm="x"'), null);
});

// --- adapters against local mocks -----------------------------------------------------------

test('Shelly Gen1: relay, meter (watt-minutes → Wh), Basic auth', async () => {
	await withPlug({ kind: 'shelly1', auth: { username: 'admin', password: 's3cret' } }, async (m) => {
		const a = createAdapter('shelly', { url: m.url, channel: 0, generation: 'auto' }, { password: 's3cret' }, deps);
		let r = await a.status();
		assert.deepEqual(r, { on: false, powerW: 0, energyWh: 1234.5, voltageV: 230.1 });
		await a.set(true);
		assert.equal(m.state.on, true);
		assert.ok(m.state.requests.some((q) => q.path === '/relay/0?turn=on'));
		r = await a.status();
		assert.equal(r.on, true);
		assert.equal(r.powerW, 42.5);
		const wrong = createAdapter('shelly', { url: m.url, channel: 0, generation: '1' }, { password: 'nope' }, deps);
		await assert.rejects(wrong.status(), (e: InstanceType<typeof PlugError>) => e.code === 'AUTH' && /credentials/.test(e.message));
		const missing = createAdapter('shelly', { url: m.url, channel: 3, generation: '1' }, { password: 's3cret' }, deps);
		await assert.rejects(missing.status(), /no relay 3/);
	});
});

test('Shelly Gen2: detected from /shelly, RPC Switch.Set/GetStatus with SHA-256 digest', async () => {
	await withPlug({ kind: 'shelly2', auth: { username: 'admin', password: 'gen2-pass' } }, async (m) => {
		const a = createAdapter('shelly', { url: `${m.url}/`, channel: 0, generation: 'auto' }, { password: 'gen2-pass' }, deps);
		assert.equal((await a.status()).on, false);
		await a.set(true);
		const r = await a.status();
		assert.deepEqual(r, { on: true, powerW: 42.5, energyWh: 1234.5, voltageV: 230.1 });
		const set = m.state.requests.filter((q) => q.path.startsWith('/rpc/Switch.Set'));
		assert.equal(set.length, 2, 'challenged once, then answered');
		assert.equal(set[0].headers.authorization, undefined, 'no Basic credentials sent to a Gen2 device');
		assert.match(set[1].headers.authorization, /^Digest .*algorithm=SHA-256/);
		const bad = createAdapter('shelly', { url: m.url, channel: 0, generation: '2' }, { password: 'wrong' }, deps);
		await assert.rejects(bad.set(false), (e: InstanceType<typeof PlugError>) => e.code === 'AUTH');
		assert.equal(m.state.on, true, 'not switched with a wrong password');
	});
	await withPlug({ kind: 'shelly2' }, async (m) => {
		const a = createAdapter('shelly', { url: m.url, channel: 0, generation: 'auto' }, {}, deps);
		await a.set(true);
		assert.equal((await a.status()).on, true, 'works without a login too');
	});
});

test('Tasmota: Power commands, Status 8 energy, user/password parameters', async () => {
	await withPlug({ kind: 'tasmota', auth: { username: 'admin', password: 'tas pw+1' } }, async (m) => {
		const a = createAdapter('tasmota', { url: m.url, channel: 0 }, { password: 'tas pw+1' }, deps);
		await a.set(true);
		const r = await a.status();
		assert.deepEqual(r, { on: true, powerW: 42.5, energyWh: 1234.5, voltageV: 231 });
		const q = m.state.requests.find((x) => x.path.includes('Power%20On'));
		assert.ok(q, 'the command is URL-encoded with %20');
		assert.match(q!.path, /user=admin&password=tas%20pw%2B1/);
		const a1 = createAdapter('tasmota', { url: m.url, channel: 1 }, { username: 'admin', password: 'tas pw+1' }, deps);
		await a1.set(false);
		assert.equal(m.state.on, false, 'Power1 on a single-relay device answers POWER');
		const anon = createAdapter('tasmota', { url: m.url, channel: 0 }, {}, deps);
		await assert.rejects(anon.status(), /asks for a login/);
	});
});

test('Home Assistant: entity state, services with the token, power/energy sensors with units', async () => {
	await withPlug({ kind: 'homeassistant', auth: { token: 'll-token' } }, async (m) => {
		const config = { url: m.url, entityId: 'switch.printer_plug', powerEntityId: 'sensor.printer_plug_power', energyEntityId: 'sensor.printer_plug_energy' };
		const a = createAdapter('homeassistant', config, { token: 'll-token' }, deps);
		await a.set(true);
		const r = await a.status();
		assert.equal(r.on, true);
		assert.equal(r.powerW, 42.5);
		assert.equal(r.energyWh, 1234.5, 'kWh converted to Wh');
		const svc = m.state.requests.find((x) => x.path === '/api/services/switch/turn_on')!;
		assert.equal(svc.headers.authorization, 'Bearer ll-token');
		assert.deepEqual(JSON.parse(svc.body), { entity_id: 'switch.printer_plug' });
		await assert.rejects(createAdapter('homeassistant', config, { token: 'bad' }, deps).status(), (e: InstanceType<typeof PlugError>) => e.code === 'AUTH');
		await assert.rejects(createAdapter('homeassistant', { ...config, entityId: 'switch.nope' }, { token: 'll-token' }, deps).status(), /no entity switch.nope/);
		// Sensors that fail don't fail the reading.
		const r2 = await createAdapter('homeassistant', { ...config, powerEntityId: 'sensor.missing' }, { token: 'll-token' }, deps).status();
		assert.equal(r2.powerW, null);
	});
});

test('generic HTTP: on/off requests, status matched against the expected body, Basic auth', async () => {
	assert.ok(matches('{"relay":"ON"}', '"relay":"on"'), 'substring, case-insensitive');
	assert.ok(matches('{"relay":"ON"}', '/"relay":\\s*"ON"/'));
	assert.ok(!matches('{"relay":"OFF"}', '/"relay":"ON"/'));
	assert.ok(!matches('x', '/[/'), 'a broken regex never matches');
	await withPlug({ kind: 'http', auth: { username: 'u', password: 'p' } }, async (m) => {
		const config = { onUrl: `${m.url}/relay/on`, onMethod: 'POST', onBody: '{"on":true}', offUrl: `${m.url}/relay/off`, offMethod: 'POST', offBody: '', contentType: 'application/json', statusUrl: `${m.url}/relay/state`, statusMethod: 'GET', onPattern: '"relay":"ON"', offPattern: '' };
		const a = createAdapter('http', config, { username: 'u', password: 'p' }, deps);
		assert.equal((await a.status()).on, false);
		await a.set(true);
		assert.equal((await a.status()).on, true);
		const on = m.state.requests.find((x) => x.path === '/relay/on')!;
		assert.equal(on.body, '{"on":true}');
		assert.equal(on.headers['content-type'], 'application/json');
		const noStatus = createAdapter('http', { ...config, statusUrl: '' }, { username: 'u', password: 'p' }, deps);
		assert.equal((await noStatus.status()).on, null, 'no status URL: unknown');
		const withOff = createAdapter('http', { ...config, offPattern: 'nothing-like-this' }, { username: 'u', password: 'p' }, deps);
		await a.set(false);
		assert.equal((await withOff.status()).on, null, 'neither pattern: unknown');
		await assert.rejects(createAdapter('http', config, {}, deps).set(true), (e: InstanceType<typeof PlugError>) => e.code === 'AUTH');
	});
});

test('network errors are readable', async () => {
	const a = createAdapter('tasmota', { url: `http://127.0.0.1:${PLUG_PORT}`, channel: 0 }, {}, deps);
	await assert.rejects(a.status(), (e: InstanceType<typeof PlugError>) => e.code === 'ECONNREFUSED' && /refused/.test(e.message));
});

// --- configuration --------------------------------------------------------------------------

test('config: validation, secrets kept/cleared, sealed at rest, no credentials in URLs', () => {
	assert.equal(cfg.deviceUrl('192.168.4.50', 'x'), 'http://192.168.4.50');
	assert.equal(cfg.deviceUrl('https://ha.lan:8123/', 'x'), 'https://ha.lan:8123');
	assert.throws(() => cfg.deviceUrl('http://admin:pw@plug.lan', 'The address'), /username and password fields/);
	assert.throws(() => cfg.deviceUrl('ftp://plug', 'The address'), /http/);
	assert.throws(() => cfg.parsePlugInput({ kind: 'zigbee' }), /kind/);
	assert.throws(() => cfg.parsePlugInput({ kind: 'homeassistant', config: { url: 'ha.lan', entityId: 'switch.x' } }), /token/);
	assert.throws(() => cfg.parsePlugInput({ kind: 'homeassistant', config: { url: 'ha.lan', entityId: 'sensor.x' }, secrets: { token: 't' } }), /entity/);
	assert.throws(() => cfg.parsePlugInput({ kind: 'http', config: { onUrl: 'h/on', offUrl: 'h/off', statusUrl: 'h/s' } }), /when the plug is on/);
	assert.throws(() => cfg.parsePlugInput({ kind: 'shelly', config: { url: 'p', channel: 9 } }), /Channel/);
	assert.throws(() => cfg.parsePlugInput({ kind: 'shelly', config: { url: 'p' }, settings: { autoOff: { idleMinutes: -1 } } }), /Idle minutes/);

	const first = cfg.parsePlugInput({ kind: 'shelly', config: { url: '10.0.0.9', channel: '1' }, secrets: { username: 'admin', password: 'pw-1' }, settings: { autoOff: { enabled: true } } });
	assert.deepEqual(first.config, { url: 'http://10.0.0.9', channel: 1, generation: 'auto' });
	assert.deepEqual(first.settings.autoOff, { enabled: true, hotendC: 50, idleMinutes: 10 }, 'defaults: below 50 °C and 10 minutes');
	assert.equal(first.settings.autoConnect, true);
	const kept = cfg.parsePlugInput({ kind: 'shelly', config: { url: '10.0.0.9' }, secrets: { password: '' } }, first);
	assert.equal(kept.secrets.password, 'pw-1', 'an empty secret keeps the stored one');
	const cleared = cfg.parsePlugInput({ kind: 'shelly', config: { url: '10.0.0.9' }, clearSecrets: ['password'] }, first);
	assert.equal(cleared.secrets.password, undefined);
	const otherKind = cfg.parsePlugInput({ kind: 'tasmota', config: { url: '10.0.0.9' } }, first);
	assert.deepEqual(otherKind.secrets, {}, 'secrets never carry over to another kind');

	const printer = store.createPrinter({ name: 'cfg', baseUrl: 'http://127.0.0.1:9', apiKey: 'key-for-cfg', verifyTls: true, webcamUrl: null, color: 'violet' });
	cfg.savePlug(printer.id, first);
	const row = store.sqlite().prepare('SELECT * FROM power_plugs WHERE printer_id = ?').get(printer.id) as Record<string, string>;
	assert.ok(row.secret.startsWith('v1:') && !row.secret.includes('pw-1') && !row.config.includes('pw-1'), 'password sealed');
	const view = cfg.configView(cfg.getPlug(printer.id)!);
	assert.deepEqual(view.secrets, { username: 'admin', password: '••••••' });
	assert.ok(!JSON.stringify(view).includes('pw-1'));
	assert.equal(cfg.describePlug(first), 'shelly 10.0.0.9 #1');
	store.deletePrinter(printer.id);
	assert.equal(cfg.getPlug(printer.id), undefined, 'removed with its printer');
	assert.ok(store.appliedMigrations().includes('power-001-plugs'));
});

test('access: plug setup is admin-only, switching is for operators', () => {
	assert.ok(adminOnlyApi('PUT', '/api/printers/abc/power/config'));
	assert.ok(adminOnlyApi('GET', '/api/printers/abc/power/config'));
	assert.ok(adminOnlyApi('POST', '/api/printers/abc/power/test'));
	assert.ok(!adminOnlyApi('POST', '/api/printers/abc/power'));
	assert.ok(controlApi('POST', '/api/printers/abc/power'), 'viewers can’t switch');
	assert.ok(!controlApi('GET', '/api/printers/abc/power'));
	assert.ok(!adminOnlyApi('GET', '/api/power'));
});

// --- auto power-off state machine ------------------------------------------------------------

test('auto-off: armed when a print ends, fires after idle time once cool; a new print cancels', () => {
	const s = { enabled: true, hotendC: 50, idleMinutes: 10 };
	const a = new AutoOff();
	const o = (now: number, state: Parameters<typeof a.observe>[0]['state'], hotendC: number | null, plugOn: boolean | null = true) => a.observe({ now, state, hotendC, plugOn }, s);
	const M = 60_000;
	assert.equal(o(0, 'operational', 25), null, 'idle printer: nothing');
	assert.equal(o(1, 'printing', 210), null);
	assert.deepEqual(o(2 * M, 'operational', 205), { type: 'armed' });
	assert.equal(a.countdown(s)!.offAt, 12 * M);
	assert.equal(a.countdown(s)!.cooling, true);
	assert.equal(o(5 * M, 'operational', 45), null, 'cool, but not idle long enough');
	assert.equal(a.countdown(s)!.cooling, false);
	assert.equal(o(12 * M, 'operational', 60), null, 'idle long enough, still hot');
	assert.deepEqual(o(13 * M, 'operational', 49), { type: 'fire' });
	assert.equal(a.armedAt, null, 'fires once');
	assert.equal(o(14 * M, 'operational', 30), null);

	// A new print cancels; an unreachable OctoPrint in between doesn't arm or cancel.
	o(20 * M, 'printing', 210);
	o(21 * M, 'offline', null);
	assert.equal(a.armedAt, null, 'offline is not "the print ended"');
	assert.deepEqual(o(22 * M, 'operational', 200), { type: 'armed' });
	assert.deepEqual(o(23 * M, 'printing', 210), { type: 'cancelled', reason: 'A new print started' });
	o(24 * M, 'operational', 200);
	assert.deepEqual(a.cancel('Kept on'), { type: 'cancelled', reason: 'Kept on' });
	assert.equal(a.cancel('again'), null);
	// The plug switched off by hand, or the feature turned off, cancels.
	o(30 * M, 'printing', 210);
	o(31 * M, 'operational', 200);
	assert.deepEqual(o(32 * M, 'operational', 190, false), { type: 'cancelled', reason: 'The plug is off' });
	o(33 * M, 'printing', 210);
	o(34 * M, 'operational', 200);
	assert.deepEqual(a.observe({ now: 35 * M, state: 'operational', hotendC: 100, plugOn: true }, { ...s, enabled: false }), { type: 'cancelled', reason: 'Auto power-off was turned off' });
	// Disabled: never arms. Unknown temperatures count as cool (e.g. disconnected).
	const b = new AutoOff();
	b.observe({ now: 0, state: 'printing', hotendC: 200, plugOn: true }, { ...s, enabled: false });
	assert.equal(b.observe({ now: 1, state: 'operational', hotendC: 200, plugOn: true }, { ...s, enabled: false }), null);
	const c = new AutoOff();
	c.observe({ now: 0, state: 'printing', hotendC: 200, plugOn: true }, { ...s, idleMinutes: 0 });
	assert.deepEqual(c.observe({ now: 1, state: 'disconnected', hotendC: null, plugOn: true }, { ...s, idleMinutes: 0 }), { type: 'armed' });
	assert.deepEqual(c.observe({ now: 2, state: 'disconnected', hotendC: null, plugOn: true }, { ...s, idleMinutes: 0 }), { type: 'fire' });
	assert.equal(maxHotend({ tool0: { actual: 40, target: 0 }, tool1: { actual: 61, target: 0 }, bed: { actual: 90, target: 0 } }), 61);
	assert.equal(maxHotend({ bed: { actual: 90, target: 0 } }), null);
});

test('formatting', () => {
	assert.equal(formatWatts(42.46), '42.5 W');
	assert.equal(formatWatts(1520), '1.52 kW');
	assert.equal(formatWatts(null), '—');
	assert.equal(formatEnergy(1234.5), '1.23 kWh');
	assert.equal(formatCountdown(65_000), '1:05');
	assert.equal(formatCountdown(3_725_000), '1:02:05');
});

// --- the service, end to end against a mock plug and a mock OctoPrint -----------------------------

const until = async (fn: () => boolean | Promise<boolean>, label: string, ms = 10_000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out: ${label}`);
};

test('service: power on → auto-connect; off needs confirming when hot, twice while printing; auto-off; ensurePrinterOn', async () => {
	const plug: Mock = await startMockPlug({ kind: 'shelly2', port: PLUG_PORT, auth: { username: 'admin', password: 'pw' } });
	const op = await startMockOctoPrint({ port: OP_PORT, apiKey: 'op-key-123', powered: () => plug.state.on, printSeconds: 1.5, coolPerSecond: 3, connectMs: 150 });
	const printer = store.createPrinter({ name: 'MK4', baseUrl: op.url, apiKey: 'op-key-123', verifyTls: true, webcamUrl: null, color: 'violet' });
	const admin = store.createUser({ email: 'admin@x.io', role: 'admin' });
	const locals = { user: admin, ip: '127.0.0.1' };
	const svc = new PowerService();
	svc.connectDelays = [100, 100, 150, 200, 200, 300, 300, 500];
	svc.deps = deps;
	svc.start();
	after(async () => {
		svc.stop();
		printers.forget(printer.id);
		await plug.close();
		await op.close();
	});
	cfg.savePlug(printer.id, cfg.parsePlugInput({ kind: 'shelly', config: { url: plug.url }, secrets: { password: 'pw' }, settings: { autoOff: { enabled: true, hotendC: 50, idleMinutes: 0 } } }));
	svc.invalidate(printer.id);
	const audits = () => store.searchAudit({ printerId: printer.id, action: 'power.' }).map((e) => `${e.action}${e.detail ? `: ${e.detail}` : ''}`);

	await printers.poll(printer.id);
	assert.equal(printers.snapshot(printer.id)?.state, 'disconnected', 'OctoPrint up, printer unpowered');
	const [info] = await svc.infos([printer.id]);
	assert.equal(info.reading?.on, false);
	assert.equal(info.reading?.powerW, 0);

	// On: the plug switches, then OctoPrint is told to connect (retries until it does).
	await svc.powerOn(printer.id, locals);
	assert.equal(plug.state.on, true);
	await until(() => svc.info(printer.id)?.connect?.phase === 'connected', 'auto-connect');
	assert.equal(printers.snapshot(printer.id)?.state, 'operational');
	assert.ok(op.state.connects >= 1);
	assert.ok(audits().some((a) => a.startsWith('power.on')));
	assert.ok(audits().some((a) => a.startsWith('power.autoconnect: connected')));

	// Hot (but idle): one confirmation.
	await fetch(`${op.url}/__mock/heat?tool=120&bed=30`);
	await printers.poll(printer.id);
	let check = await svc.offCheck(printer.id, {});
	assert.equal(check.confirm?.stage, 'hot');
	assert.match(check.confirm!.message, /hotend 1\d\d °C/);
	check = await svc.offCheck(printer.id, { confirm: true });
	assert.equal(check.confirm, null);
	assert.match(check.overridden!, /while hot/);

	// Printing: two confirmations, always.
	await fetch(`${op.url}/__mock/print?file=benchy.gcode`);
	await printers.poll(printer.id);
	assert.equal((await svc.offCheck(printer.id, {})).confirm?.stage, 'printing');
	const second = await svc.offCheck(printer.id, { confirm: true });
	assert.equal(second.confirm?.stage, 'printing-final');
	assert.equal(second.confirm?.field, 'confirmPrinting');
	assert.equal((await svc.offCheck(printer.id, { confirmPrinting: true })).confirm?.stage, 'printing', 'the second confirmation alone isn’t enough');
	assert.match((await svc.offCheck(printer.id, { confirm: true, confirmPrinting: true })).overridden!, /during a print of benchy.gcode/);

	// The print ends (watched through live updates): auto-off arms, waits for the hotend to cool, then fires.
	const live = printers.subscribe(printer.id, () => {});
	try {
		await until(async () => {
			await printers.poll(printer.id);
			return audits().some((a) => a.startsWith('power.auto_off.armed'));
		}, 'auto-off armed');
		assert.equal(svc.info(printer.id)?.countdown?.cooling, true, 'still hot right after the print');
		await until(async () => {
			await printers.poll(printer.id);
			await svc.tick();
			return !plug.state.on;
		}, 'auto power-off');
	} finally {
		live();
	}
	assert.ok(audits().some((a) => /^power\.auto_off: idle 0 min, hotend below 50 °C/.test(a)));
	assert.ok(op.state.requests.some((r: { method: string; path: string }) => r.path === '/api/connection' && r.method === 'POST'), 'disconnected before the power went');
	assert.equal(svc.info(printer.id)?.countdown, null);

	// Keep on: cancels a running countdown.
	assert.equal(svc.keepOn(printer.id, locals), false, 'nothing to keep on');

	// ensurePrinterOn: does nothing unless auto power-on is enabled (or forced)…
	const skipped = await svc.ensurePrinterOn(printer.id);
	assert.equal(skipped.reason, 'auto-on-disabled');
	assert.equal(plug.state.on, false);
	// …then powers on and waits for the printer to connect; concurrent callers share one run.
	cfg.savePlug(printer.id, { ...cfg.getPlug(printer.id)!, settings: { ...cfg.getPlug(printer.id)!.settings, autoOn: true } });
	svc.invalidate(printer.id);
	await printers.poll(printer.id);
	const [r1, r2] = await Promise.all([svc.ensurePrinterOn(printer.id, { reason: 'queued job' }), svc.ensurePrinterOn(printer.id)]);
	assert.equal(r1, r2);
	assert.equal(r1.changed, true);
	assert.equal(r1.ready, true);
	assert.equal(r1.state, 'operational');
	assert.ok(audits().some((a) => a === 'power.auto_on: queued job'));
	const again = await svc.ensurePrinterOn(printer.id);
	assert.equal(again.changed, false, 'already on');
	assert.equal(again.ready, true);

	// A plug that fails: the error is kept and the switch is audited as failed.
	plug.state.failNext = 1;
	await assert.rejects(svc.powerOff(printer.id, locals));
	assert.match(svc.info(printer.id)!.error!, /HTTP 500/);
	assert.ok(audits().some((a) => /^power\.off: failed/.test(a)));
	await svc.powerOff(printer.id, locals, { detail: 'test' });
	assert.equal(plug.state.on, false);
	assert.equal(svc.info(printer.id)!.error, null);

	// No plug: nothing happens.
	cfg.deletePlug(printer.id);
	svc.invalidate(printer.id);
	assert.equal((await svc.ensurePrinterOn(printer.id, { force: true })).reason, 'no-plug');
	assert.equal(svc.info(printer.id), null);
});
