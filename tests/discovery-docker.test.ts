import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-discovery-docker-'));
const { detectOctoPrint, imageName, serialDevices, containerAddresses } = await import('../src/lib/server/discovery/containers.ts');
const { scanDockerEndpoint, publishedHost } = await import('../src/lib/server/discovery/docker.ts');
const { findSelf, networkPath } = await import('../src/lib/server/discovery/network.ts');

const base = { env: {}, labels: {}, exposed: [] as number[], published: [] as { containerPort: number; host: string; port: number }[], name: 'x' };

test('images: registry and tag are stripped', () => {
	assert.deepEqual(imageName('ghcr.io/linuxserver/octoprint:1.10.2'), { path: 'linuxserver/octoprint', tag: '1.10.2' });
	assert.deepEqual(imageName('octoprint/octoprint'), { path: 'octoprint/octoprint', tag: null });
	assert.deepEqual(imageName('registry.lan:5000/me/octoprint:latest@sha256:abc'), { path: 'me/octoprint', tag: 'latest' });
});

test('OctoPrint containers are recognized by image, env, labels or name; companions are not', () => {
	assert.equal(detectOctoPrint({ ...base, image: 'octoprint/octoprint:1.11.8', exposed: [80] })?.versionHint, '1.11.8');
	assert.deepEqual(detectOctoPrint({ ...base, image: 'octoprint/octoprint:latest', exposed: [80] })?.ports, [80]);
	assert.equal(detectOctoPrint({ ...base, image: 'octoprint/octoprint:latest', env: { octoprint_ref: '1.11.8' }, exposed: [80] })?.versionHint, '1.11.8');
	assert.equal(detectOctoPrint({ ...base, image: 'lscr.io/linuxserver/octoprint', exposed: [5000] })?.reason, 'image linuxserver/octoprint');
	assert.deepEqual(detectOctoPrint({ ...base, image: 'octoprint/octoprint:1.10-minimal' })?.ports, [80, 5000], 'nothing exposed: try both');
	assert.equal(detectOctoPrint({ ...base, image: 'me/printer-ui:3', exposed: [5000], env: { OCTOPRINT_PORT: '5000' } })?.reason, 'OctoPrint environment variables');
	assert.equal(detectOctoPrint({ ...base, image: 'me/custom:1', exposed: [80], labels: { 'org.opencontainers.image.source': 'https://github.com/OctoPrint/octoprint-docker' } })?.reason, 'label org.opencontainers.image.source');
	assert.equal(detectOctoPrint({ ...base, image: 'me/custom:1', exposed: [80], name: 'octopi-ender3' })?.reason, 'container name');
	assert.equal(detectOctoPrint({ ...base, image: 'me/custom:1', name: 'octopi-ender3' }), null, 'a name alone, with no web port, is not enough');
	assert.equal(detectOctoPrint({ ...base, image: 'nginx:alpine', exposed: [80] }), null);
	assert.equal(detectOctoPrint({ ...base, image: 'ghcr.io/someone/octoprint-exporter', exposed: [9529] }), null);
	assert.equal(detectOctoPrint({ ...base, image: 'thespaghettidetective/obico-server', exposed: [3334], name: 'octoprint-obico' }), null);
});

test('serial devices mapped into the container', () => {
	assert.deepEqual(
		serialDevices({
			devices: [
				{ host: '/dev/ttyACM0', container: '/dev/ttyACM0' },
				{ host: '/dev/video0', container: '/dev/video0' }
			],
			binds: [
				{ source: '/dev/serial/by-id/usb-Prusa_Research_Original_Prusa_MK4-if00', destination: '/dev/ttyPrinter' },
				{ source: '/opt/octoprint', destination: '/octoprint' }
			],
			privileged: false
		}),
		[
			{ host: '/dev/ttyACM0', container: '/dev/ttyACM0', via: 'device' },
			{ host: '/dev/serial/by-id/usb-Prusa_Research_Original_Prusa_MK4-if00', container: '/dev/ttyPrinter', via: 'bind' }
		]
	);
	assert.deepEqual(serialDevices({ devices: [], binds: [{ source: '/dev', destination: '/dev' }], privileged: true }), [{ host: '/dev', container: '/dev', via: 'privileged' }]);
	assert.deepEqual(serialDevices({ devices: [], binds: [], privileged: false }), []);
});

test('published ports resolve to an address that reaches the Docker host', () => {
	assert.equal(publishedHost('unix:///var/run/docker.sock', '0.0.0.0', true), 'host.docker.internal');
	assert.equal(publishedHost('unix:///var/run/docker.sock', '127.0.0.1', false), '127.0.0.1');
	assert.equal(publishedHost('tcp://192.168.4.23:2375', '0.0.0.0'), '192.168.4.23');
	assert.equal(publishedHost('tcp://192.168.4.23:2375', '10.0.0.5'), '10.0.0.5');
});

test('candidate addresses: host networking, published ports, container name, network IPs', () => {
	const c = { ...base, id: 'abc', image: 'octoprint/octoprint', state: 'running', status: 'Up', name: 'octoprint', published: [{ containerPort: 80, host: '192.168.4.23', port: 5001 }], networks: { printers: '172.20.0.3' }, devices: [], binds: [], privileged: false };
	const det = { ports: [80], reason: 'image', versionHint: null };
	assert.deepEqual(
		containerAddresses(c, det, { inContainer: true, dockerHost: '192.168.4.23' }).map((a) => `${a.host}:${a.port} ${a.label}`),
		['192.168.4.23:5001 published port', 'octoprint:80 container name', '172.20.0.3:80 printers network']
	);
	assert.deepEqual(
		containerAddresses({ ...c, networkMode: 'host', networks: { host: '' } }, det, { inContainer: false, dockerHost: '192.168.4.23' }).map((a) => `${a.host}:${a.port} ${a.label}`),
		['192.168.4.23:80 host network']
	);
});

test('network path: shared network, published port, or none with the network to join', () => {
	const self = findSelf(
		[
			{ id: 'aaaaaaaaaaaa1', name: 'octo-modern', networks: { 'octo-modern_default': '172.30.0.2', printers: '172.20.0.9' }, published: [], running: true },
			{ id: 'bbbbbbbbbbbb2', name: 'octoprint', networks: { printers: '172.20.0.3' }, published: [], running: true }
		],
		{ inContainer: true, host: 'aaaaaaaaaaaa', addresses: new Set() }
	);
	assert.deepEqual(self, { inContainer: true, container: 'octo-modern', networks: ['octo-modern_default', 'printers'] });
	assert.equal(networkPath({ id: 'b', name: 'octoprint', networks: { printers: '' }, published: [], running: true }, self, 80).via, 'shared-network');
	assert.equal(networkPath({ id: 'b', name: 'op', networks: { op_default: '' }, published: [{ host: 'h', port: 5001 }], running: true }, self, 80).via, 'published-port');
	assert.deepEqual(networkPath({ id: 'b', name: 'op', networks: { op_default: '' }, published: [], running: true }, self, 80), {
		networks: ['op_default'],
		shared: [],
		published: [],
		via: 'none',
		join: 'op_default',
		publish: 80
	});
	assert.equal(findSelf([], { inContainer: false, named: '' }).container, undefined);
});

test('a Docker endpoint scan finds OctoPrint containers with their devices and addresses', async () => {
	const containers = [
		{
			Id: 'a1'.repeat(32),
			Name: '/octoprint-mk4',
			State: 'running',
			Status: 'Up 2 days',
			Config: { Image: 'octoprint/octoprint:1.11.8', Env: ['octoprint_ref=1.11.8'], Labels: { 'com.docker.compose.project': 'printers', 'com.docker.compose.service': 'mk4' }, ExposedPorts: { '80/tcp': {} } },
			HostConfig: { NetworkMode: 'printers_default', Devices: [{ PathOnHost: '/dev/ttyACM0', PathInContainer: '/dev/ttyACM0' }] },
			NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '5001' }] }, Networks: { printers_default: { IPAddress: '172.20.0.3' } } }
		},
		{
			Id: 'b2'.repeat(32),
			Name: '/octoprint-ender',
			State: 'exited',
			Status: 'Exited (0) 3 days ago',
			Config: { Image: 'lscr.io/linuxserver/octoprint:latest', Env: [], Labels: {}, ExposedPorts: { '5000/tcp': {} } },
			HostConfig: { Binds: ['/dev/ttyUSB0:/dev/ttyUSB0'] },
			NetworkSettings: { Ports: {}, Networks: {} }
		},
		{
			Id: 'c3'.repeat(32),
			Name: '/nginx',
			State: 'running',
			Status: 'Up',
			Config: { Image: 'nginx:alpine', Env: [], Labels: {}, ExposedPorts: { '80/tcp': {} } },
			NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }, Networks: { bridge: { IPAddress: '172.17.0.2' } } }
		}
	];
	const server = createServer((req, res) => {
		const send = (b: unknown, s = 200) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(b));
		if (req.method !== 'GET') return send({ message: 'read-only' }, 403);
		if (req.url === '/containers/json?all=1') return send(containers.map((c) => ({ Id: c.Id, Names: [c.Name], Image: c.Config.Image, State: c.State, Status: c.Status, NetworkSettings: { Networks: c.NetworkSettings.Networks } })));
		const m = /^\/containers\/([^/]+)\/json$/.exec(req.url ?? '');
		const c = m && containers.find((x) => x.Id === m[1]);
		return c ? send(c) : send({ message: 'no such container' }, 404);
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	const endpoint = `tcp://127.0.0.1:${(server.address() as { port: number }).port}`;
	try {
		const scan = await scanDockerEndpoint(endpoint, {
			inContainer: false,
			settle: {
				probe: async (h, p) => h === '127.0.0.1' && p === 5001,
				fingerprint: async () => ({ confidence: 'confirmed', version: null, apiVersion: null, appkeys: true, loginRequired: true, signals: ['GET /plugin/appkeys/probe → 204'] })
			}
		});
		assert.equal(scan.error, undefined);
		assert.equal(scan.inspected, 3);
		assert.deepEqual(scan.candidates.map((c) => c.name), ['octoprint-mk4', 'octoprint-ender'], 'running first; nginx is skipped');
		const [mk4, ender] = scan.candidates;
		assert.equal(mk4.baseUrl, 'http://127.0.0.1:5001');
		assert.equal(mk4.reachable, true);
		assert.equal(mk4.fingerprint.version, '1.11.8', 'from the image when the server hides it');
		assert.deepEqual(mk4.serial, [{ host: '/dev/ttyACM0', container: '/dev/ttyACM0', via: 'device' }]);
		assert.equal(mk4.network?.via, 'published-port');
		assert.equal(mk4.key, `docker:${endpoint}#octoprint-mk4`);
		assert.deepEqual(mk4.alternates.map((a) => a.url), ['http://172.20.0.3']);
		assert.equal(mk4.container?.project, 'printers');
		assert.equal(ender.reachable, false);
		assert.equal(ender.container?.state, 'exited');
		assert.deepEqual(ender.serial.map((s) => s.host), ['/dev/ttyUSB0']);
		assert.equal(ender.network, undefined, 'no network path for a stopped container');
	} finally {
		server.close();
	}
	const refused = await scanDockerEndpoint('tcp://127.0.0.1:1');
	assert.match(refused.error ?? '', /Connection refused/);
});
