import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-discovery-fp-'));
const { analyzeFingerprint, fingerprintUrl } = await import('../src/lib/server/discovery/fingerprint.ts');
const { settle } = await import('../src/lib/server/discovery/settle.ts');

const FORBIDDEN = JSON.stringify({ error: "You don't have the permission to access the requested resource. It is either read-protected or not readable by the server." }, null, 2);
const CLACKS = { 'x-clacks-overhead': 'GNU Terry Pratchett' };

test('modern OctoPrint (1.5+): 403 on the API, appkeys probe 204, login redirect', () => {
	const fp = analyzeFingerprint({
		version: { status: 403, headers: CLACKS, body: FORBIDDEN },
		appkeys: { status: 204, headers: CLACKS, body: '' },
		root: { status: 302, headers: { ...CLACKS, location: '/login/?redirect=/?&permissions=STATUS,SETTINGS_READ' }, body: '' }
	});
	assert.equal(fp.confidence, 'confirmed');
	assert.equal(fp.appkeys, true);
	assert.equal(fp.loginRequired, true);
	assert.equal(fp.version, null, 'the version is hidden without a key');
	assert.equal(fp.signals.length, 3);
});

test('anonymous API access reveals the version', () => {
	const fp = analyzeFingerprint({ version: { status: 200, body: JSON.stringify({ api: '0.1', server: '1.4.2', text: 'OctoPrint 1.4.2' }) }, appkeys: { status: 204 } });
	assert.deepEqual([fp.confidence, fp.version, fp.apiVersion, fp.loginRequired], ['confirmed', '1.4.2', '0.1', false]);
});

test('the login page or an old UI page is recognized by its title, with a version when shown', () => {
	const login = analyzeFingerprint({
		root: { status: 302, headers: { location: '/login/' } },
		login: { status: 200, body: '<html><head><title>OctoPrint Login</title><link rel="shortcut icon" href="/static/img/tentacle-32x32.png"></head></html>' }
	});
	assert.equal(login.confidence, 'confirmed');
	const old = analyzeFingerprint({ root: { status: 200, body: '<title>OctoPrint</title><script>var DISPLAY_VERSION = "1.3.12";</script>' } });
	assert.deepEqual([old.confidence, old.version], ['confirmed', '1.3.12']);
});

test('other servers are not OctoPrint; generic 403s only count as possible', () => {
	const nginx = analyzeFingerprint({
		version: { status: 404, body: '<html><title>404 Not Found</title></html>' },
		appkeys: { status: 404 },
		root: { status: 200, body: '<title>Welcome to nginx!</title>' }
	});
	assert.equal(nginx.confidence, 'none');
	// Something else that happens to answer /api/version with JSON.
	const other = analyzeFingerprint({ version: { status: 200, body: JSON.stringify({ version: '2.0', server: 'Jellyfin' }) } });
	assert.equal(other.confidence, 'none');
	const maybe = analyzeFingerprint({ version: { status: 403, body: FORBIDDEN }, appkeys: { status: 404 }, root: { status: 302, headers: { location: '/auth' } } });
	assert.equal(maybe.confidence, 'possible');
	const redirectElsewhere = analyzeFingerprint({ root: { status: 302, headers: { location: '/login/?redirect=/' } } });
	assert.equal(redirectElsewhere.confidence, 'none', 'a login redirect without OctoPrint’s permissions= is not enough');
});

/** A server that answers like OctoPrint 1.11 (or not, when `octoprint` is false). */
async function fakeServer(octoprint: boolean): Promise<{ server: Server; url: string }> {
	const server = createServer((req, res) => {
		if (!octoprint) return res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Home Assistant</title>');
		if (req.url === '/api/version') return res.writeHead(403, { 'content-type': 'application/json', ...CLACKS }).end(FORBIDDEN);
		if (req.url === '/plugin/appkeys/probe') return res.writeHead(204).end();
		if (req.url === '/') return res.writeHead(302, { location: '/login/?redirect=/?&permissions=STATUS,SETTINGS_READ' }).end();
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test('fingerprintUrl talks to a server without a key and does not follow redirects', async () => {
	const op = await fakeServer(true);
	const ha = await fakeServer(false);
	try {
		const a = await fingerprintUrl(op.url);
		assert.equal(a.confidence, 'confirmed');
		assert.equal(a.answered, true);
		assert.ok(a.signals.some((s) => /login redirect/.test(s)));
		const b = await fingerprintUrl(ha.url);
		assert.equal(b.confidence, 'none');
		const c = await fingerprintUrl('http://127.0.0.1:1', { timeoutMs: 500 });
		assert.deepEqual([c.confidence, c.answered], ['none', false]);
	} finally {
		op.server.close();
		ha.server.close();
	}
});

test('settling makes the first address that answers as OctoPrint primary', async () => {
	const reachable = new Set(['127.0.0.1:5000', '172.18.0.5:80', '10.0.0.9:80']);
	const octo = new Set(['http://172.18.0.5']);
	const fingerprinted: string[] = [];
	const s = await settle(
		[
			{ host: 'octoprint', port: 80, label: 'container name' },
			{ host: '127.0.0.1', port: 5000, label: 'published port' },
			{ host: '172.18.0.5', port: 80, label: 'printers network' },
			{ host: '10.0.0.9', port: 80, label: 'bridge network' },
			{ host: '172.18.0.5', port: 80, label: 'duplicate' }
		],
		{
			probe: async (h, p) => reachable.has(`${h}:${p}`),
			fingerprint: async (url) => {
				fingerprinted.push(url);
				return { confidence: octo.has(url) ? 'confirmed' : 'none', version: null, apiVersion: null, appkeys: octo.has(url), loginRequired: true, signals: [] };
			}
		}
	);
	assert.equal(s.baseUrl, 'http://172.18.0.5');
	assert.equal(s.primary.label, 'printers network');
	assert.equal(s.reachable, true);
	assert.equal(s.fingerprint.confidence, 'confirmed');
	assert.deepEqual(fingerprinted, ['http://127.0.0.1:5000', 'http://172.18.0.5'], 'unreachable addresses are not fingerprinted; it stops at the first confirmed one');
	assert.deepEqual(
		s.alternates.map((a) => [a.url, a.reachable]),
		[
			['http://octoprint', false],
			['http://127.0.0.1:5000', true],
			['http://10.0.0.9', true]
		],
		'duplicates are dropped'
	);

	const none = await settle([{ host: 'a', port: 80, label: 'x' }, { host: 'b', port: 443, label: 'y' }], { probe: async () => false, fingerprint: async () => assert.fail('nothing to fingerprint') });
	assert.equal(none.baseUrl, 'http://a');
	assert.equal(none.reachable, false);
	assert.equal(none.alternates[0].url, 'https://b');
});
