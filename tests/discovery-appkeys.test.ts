import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-discovery-appkeys-'));
const { AppKeyRequests, APP_NAME } = await import('../src/lib/server/discovery/appkeys.ts');
const { matchSaved } = await import('../src/lib/server/discovery/saved.ts');
const { parsePorts, parseTargets, scanSubnet } = await import('../src/lib/server/discovery/lan.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (req: IncomingMessage) => new Promise<string>((r) => {
	let s = '';
	req.on('data', (d) => (s += d));
	req.on('end', () => r(s));
});

/**
 * Mimics OctoPrint's appkeys plugin. `decide` is what the admin does in OctoPrint:
 * approve or deny after N polls, or never.
 */
async function fakeOctoPrint(opts: { plugin?: boolean; decide?: { after: number; approve: boolean }; rateLimited?: boolean } = {}) {
	const log: string[] = [];
	let polls = 0;
	let requested: Record<string, unknown> | null = null;
	const server = createServer(async (req, res) => {
		log.push(`${req.method} ${req.url}`);
		if (req.url === '/plugin/appkeys/probe') return res.writeHead(opts.plugin === false ? 404 : 204).end();
		if (req.url === '/plugin/appkeys/request' && req.method === 'POST') {
			if (opts.rateLimited) return res.writeHead(429).end();
			requested = JSON.parse(await read(req));
			return res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ app_token: 'tok-123', auth_dialog: `http://${req.headers.host}/plugin/appkeys/auth/tok-123` }));
		}
		if (req.url === '/plugin/appkeys/request/tok-123') {
			polls++;
			if (opts.decide && polls > opts.decide.after) {
				if (opts.decide.approve) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ api_key: 'APPROVED-KEY-0123456789' }));
				return res.writeHead(404).end();
			}
			return res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Awaiting decision' }));
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, log, polls: () => polls, requested: () => requested };
}

async function until<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = fn();
		if (v) return v;
		await sleep(10);
	}
	throw new Error('timed out');
}

test('approved: probe, request, poll until the key arrives; the key is never in the state', async () => {
	const op = await fakeOctoPrint({ decide: { after: 3, approve: true } });
	const reqs = new AppKeyRequests({ pollMs: 20 });
	try {
		const s = await reqs.start(op.url);
		assert.equal(s.state, 'pending');
		assert.equal(s.authDialog, `${op.url}/plugin/appkeys/auth/tok-123`);
		assert.deepEqual(op.requested(), { app: APP_NAME });
		const done = await until(() => (reqs.status(s.id)?.state === 'approved' ? reqs.status(s.id) : undefined));
		assert.ok(!JSON.stringify(done).includes('APPROVED-KEY'), 'the browser-facing state has no key');
		assert.equal(op.polls(), 4);
		assert.deepEqual(op.log.slice(0, 2), ['GET /plugin/appkeys/probe', 'POST /plugin/appkeys/request']);
		assert.equal(reqs.key(s.id, `${op.url}/`), 'APPROVED-KEY-0123456789');
		assert.equal(reqs.key(s.id, 'http://elsewhere'), undefined, 'only for the address it was requested from');
		reqs.cancel(s.id);
		assert.equal(reqs.key(s.id), undefined);
		assert.equal(reqs.status(s.id), undefined);
	} finally {
		op.server.close();
	}
});

test('denied in OctoPrint (404 on the poll)', async () => {
	const op = await fakeOctoPrint({ decide: { after: 1, approve: false } });
	const reqs = new AppKeyRequests({ pollMs: 20 });
	try {
		const s = await reqs.start(op.url, { user: 'admin' });
		assert.deepEqual(op.requested(), { app: APP_NAME, user: 'admin' });
		const done = await until(() => (reqs.status(s.id)?.state !== 'pending' ? reqs.status(s.id) : undefined));
		assert.equal(done.state, 'denied');
		assert.equal(reqs.key(s.id), undefined);
	} finally {
		op.server.close();
	}
});

test('nobody decides: octo·modern stops waiting', async () => {
	const op = await fakeOctoPrint();
	const reqs = new AppKeyRequests({ pollMs: 20, timeoutMs: 150 });
	try {
		const s = await reqs.start(op.url);
		const done = await until(() => (reqs.status(s.id)?.state !== 'pending' ? reqs.status(s.id) : undefined));
		assert.equal(done.state, 'expired');
		const polls = op.polls();
		await sleep(80);
		assert.equal(op.polls(), polls, 'polling stopped');
	} finally {
		op.server.close();
	}
});

test('no appkeys plugin, rate limits and unreachable servers fail with a way forward', async () => {
	const old = await fakeOctoPrint({ plugin: false });
	const limited = await fakeOctoPrint({ rateLimited: true });
	const reqs = new AppKeyRequests({ pollMs: 20 });
	try {
		const a = await reqs.start(old.url);
		assert.equal(a.state, 'error');
		assert.match(a.message ?? '', /Paste an API key/);
		assert.ok(!old.log.includes('POST /plugin/appkeys/request'), 'no request without the plugin');
		const b = await reqs.start(limited.url);
		assert.match(b.message ?? '', /3 a minute/);
		const closed = createServer();
		await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
		const port = (closed.address() as { port: number }).port;
		await new Promise((r) => closed.close(r));
		const c = await reqs.start(`http://127.0.0.1:${port}`);
		assert.equal(c.state, 'error');
		assert.match(c.message ?? '', /Couldn’t reach OctoPrint.*ECONNREFUSED/);
	} finally {
		old.server.close();
		limited.server.close();
	}
});

// --- saved matching -------------------------------------------------------------

const cand = (over: Record<string, unknown> = {}) =>
	({
		key: 'docker:unix:///var/run/docker.sock#octoprint-mk4',
		name: 'octoprint-mk4',
		baseUrl: 'http://127.0.0.1:5001',
		alternates: [{ url: 'http://172.20.0.3', label: 'printers network', reachable: false }],
		reachable: true,
		fingerprint: { confidence: 'confirmed', version: null, apiVersion: null, appkeys: true, loginRequired: true, signals: [] },
		source: { kind: 'docker', ref: 'unix:///var/run/docker.sock#octoprint-mk4', label: 'unix:///var/run/docker.sock' },
		serial: [],
		notes: [],
		...over
	}) as Parameters<typeof matchSaved>[0];

test('saved printers match by any address (ignoring default ports and case)', () => {
	const saved = matchSaved(cand(), [{ id: 'p1', name: 'MK4', baseUrl: 'HTTP://127.0.0.1:5001/' }], {});
	assert.deepEqual(saved, { id: 'p1', name: 'MK4', baseUrl: 'HTTP://127.0.0.1:5001/', addressChanged: false });
	assert.equal(matchSaved(cand({ baseUrl: 'http://octopi.lan' }), [{ id: 'p', name: 'Pi', baseUrl: 'http://octopi.lan:80' }], {})?.addressChanged, false);
	assert.equal(matchSaved(cand(), [{ id: 'p2', name: 'Other', baseUrl: 'http://127.0.0.1:5002' }], {}), undefined);
});

test('the same container at a new address is flagged "address changed"', () => {
	const sources = { p1: { kind: 'docker', ref: 'unix:///var/run/docker.sock#octoprint-mk4' } };
	assert.deepEqual(matchSaved(cand(), [{ id: 'p1', name: 'MK4', baseUrl: 'http://127.0.0.1:5000' }], sources), {
		id: 'p1',
		name: 'MK4',
		baseUrl: 'http://127.0.0.1:5000',
		addressChanged: true
	});
	// Saved on an alternate the scan can't reach, while the primary answers: offer to switch.
	assert.equal(matchSaved(cand(), [{ id: 'p1', name: 'MK4', baseUrl: 'http://172.20.0.3' }], {})?.addressChanged, true);
	// Saved on a reachable alternate: fine as it is.
	const reachableAlt = cand({ alternates: [{ url: 'http://172.20.0.3', label: 'printers network', reachable: true }] });
	assert.equal(matchSaved(reachableAlt, [{ id: 'p1', name: 'MK4', baseUrl: 'http://172.20.0.3' }], {})?.addressChanged, false);
	// Another source kind with the same ref is not the same printer.
	assert.equal(matchSaved(cand(), [{ id: 'p1', name: 'MK4', baseUrl: 'http://10.0.0.1' }], { p1: { kind: 'arcane', ref: sources.p1.ref } }), undefined);
});

// --- subnet scan ------------------------------------------------------------------

test('subnet input: CIDRs, ranges, addresses and limits', () => {
	assert.equal(parseTargets('192.168.4.0/24').length, 254);
	assert.deepEqual(parseTargets('192.168.4.0/24').slice(0, 2), ['192.168.4.1', '192.168.4.2']);
	assert.deepEqual(parseTargets('10.0.0.8/30'), ['10.0.0.9', '10.0.0.10']);
	assert.deepEqual(parseTargets('10.0.0.5/32, 10.0.0.20-22 octopi.lan 10.0.0.5'), ['10.0.0.5', '10.0.0.20', '10.0.0.21', '10.0.0.22', 'octopi.lan']);
	assert.equal(parseTargets('10.1.0.0/20').length, 4094);
	assert.throws(() => parseTargets('10.0.0.0/16'), /too large/);
	assert.throws(() => parseTargets('10.0.0.300/24'), /valid/);
	assert.throws(() => parseTargets(''), /Enter a subnet/);
	assert.throws(() => parseTargets('http://x'), /isn't an address/);
	assert.deepEqual(parsePorts(''), [80, 5000, 443]);
	assert.deepEqual(parsePorts('5151-5153, 80'), [5151, 5152, 5153, 80]);
	assert.throws(() => parsePorts('1-100'), /at most 32/);
	assert.throws(() => parsePorts('99999'), /valid port/);
});

test('subnet scan: probes every address × port with bounded concurrency, keeps OctoPrint only', async () => {
	let inFlight = 0;
	let peak = 0;
	const open = new Set(['10.0.0.5:80', '10.0.0.5:5000', '10.0.0.7:80', '10.0.0.9:443']);
	const scan = await scanSubnet('10.0.0.0/28', '80, 5000, 443', {
		concurrency: 8,
		reverseDns: false,
		probe: async (h, p) => {
			peak = Math.max(peak, ++inFlight);
			await sleep(2);
			inFlight--;
			return open.has(`${h}:${p}`);
		},
		fingerprint: async (url) => ({
			confidence: url === 'http://10.0.0.5' || url === 'https://10.0.0.9' ? 'confirmed' : 'none',
			version: null,
			apiVersion: null,
			appkeys: true,
			loginRequired: true,
			signals: []
		})
	});
	assert.equal(scan.probed, 14 * 3);
	assert.ok(peak <= 8, `concurrency stayed bounded (${peak})`);
	assert.deepEqual(scan.candidates.map((c) => c.baseUrl), ['http://10.0.0.5', 'https://10.0.0.9'], 'the nginx on .7 is not listed');
	assert.deepEqual(scan.candidates[0].alternates.map((a) => a.url), ['http://10.0.0.5:5000'], 'one candidate per host');
	assert.equal(scan.candidates[1].insecureTls, true);
	assert.equal(scan.candidates[0].source.kind, 'subnet');
});
