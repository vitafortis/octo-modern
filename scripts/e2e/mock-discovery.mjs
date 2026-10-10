// Stand-ins for what Discover reads, pointing at real OctoPrint containers on 127.0.0.1:
// a Docker Engine API, an Arcane API, a unicast mDNS responder and a TCP port forwarder.
// Fictional names and devices keep screenshots free of whoever runs the script's containers.
import { createServer } from 'node:http';
import { createServer as createTcpServer, connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { decodeMessage, encodeMessage, TYPE } from '../../src/lib/server/discovery/mdns.ts';

const listen = (server, port, host = '127.0.0.1') => new Promise((resolve) => server.listen(port, host, () => resolve(server)));
const sendJson = (res, body, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

/** Docker Engine API (GET only, like docker-socket-proxy with CONTAINERS=1). `ports` maps printer → host port. */
export async function startMockDocker({ port, ports }) {
	const published = (p) => (p ? { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: String(p) }] } : {});
	const op = (id, name, image, extra) => ({
		Id: id.padEnd(64, '0'),
		Name: `/${name}`,
		State: 'running',
		Status: 'Up 4 days',
		Config: { Image: image, Env: ['octoprint_ref=1.11.8', 'CAMERA_DEV=/dev/video0'], Labels: { 'com.docker.compose.project': 'printers', 'com.docker.compose.service': name.replace(/^octoprint-/, '') }, ExposedPorts: { '80/tcp': {} } },
		HostConfig: { NetworkMode: 'printers_default', Devices: [], Binds: [] },
		NetworkSettings: { Ports: {}, Networks: {} },
		...extra
	});
	const containers = () => [
		op('a1b2c3d4e5f6', 'octoprint-mk4', 'octoprint/octoprint:1.11.8', {
			HostConfig: { Devices: [{ PathOnHost: '/dev/serial/by-id/usb-Prusa_Research_Original_Prusa_MK4_4914-if00', PathInContainer: '/dev/ttyACM0' }], Binds: ['octoprint-mk4:/octoprint'] },
			NetworkSettings: { Ports: published(ports.mk4), Networks: { printers_default: { IPAddress: '172.20.0.3' } } }
		}),
		op('b2c3d4e5f6a1', 'octoprint-ender3', 'octoprint/octoprint:1.11.8', {
			HostConfig: { Devices: [{ PathOnHost: '/dev/ttyUSB0', PathInContainer: '/dev/ttyUSB0' }] },
			NetworkSettings: { Ports: published(ports.ender3), Networks: { printers_default: { IPAddress: '172.20.0.4' } } }
		}),
		op('c3d4e5f6a1b2', 'octoprint-voron', 'octoprint/octoprint:1.11.8', {
			Config: { Image: 'octoprint/octoprint:1.11.8', Env: ['octoprint_ref=1.11.8'], Labels: { 'com.docker.compose.project': 'voron', 'com.docker.compose.service': 'octoprint' }, ExposedPorts: { '80/tcp': {} } },
			HostConfig: { Privileged: false, Binds: ['/dev/ttyACM1:/dev/ttyACM0', '/srv/voron/octoprint:/octoprint'] },
			NetworkSettings: { Ports: published(ports.voron), Networks: { voron_default: { IPAddress: '172.21.0.2' } } }
		}),
		op('d4e5f6a1b2c3', 'octoprint-garage', 'octoprint/octoprint:1.10.3', {
			Config: { Image: 'octoprint/octoprint:1.10.3', Env: ['octoprint_ref=1.10.3'], Labels: { 'com.docker.compose.project': 'garage', 'com.docker.compose.service': 'octoprint' }, ExposedPorts: { '80/tcp': {} } },
			HostConfig: { Devices: [{ PathOnHost: '/dev/ttyUSB1', PathInContainer: '/dev/ttyUSB0' }] },
			NetworkSettings: { Ports: {}, Networks: { garage_default: { IPAddress: '172.31.9.2' } } }
		}),
		op('e5f6a1b2c3d4', 'octoprint-bambu', 'octoprint/octoprint:1.9.3', {
			State: 'exited',
			Status: 'Exited (0) 2 weeks ago',
			Config: { Image: 'octoprint/octoprint:1.9.3', Env: [], Labels: {}, ExposedPorts: { '80/tcp': {} } },
			NetworkSettings: { Ports: {}, Networks: {} }
		}),
		{
			Id: 'f6a1b2c3d4e5'.padEnd(64, '0'),
			Name: '/octo-modern',
			State: 'running',
			Status: 'Up 2 hours',
			Config: { Image: 'ghcr.io/vitafortis/octo-modern:latest', Env: [], Labels: {}, ExposedPorts: { '3000/tcp': {} } },
			HostConfig: {},
			NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3040' }] }, Networks: { 'octo-modern_default': { IPAddress: '172.30.0.2' }, printers_default: { IPAddress: '172.20.0.9' } } }
		},
		{
			Id: '0a1b2c3d4e5f'.padEnd(64, '0'),
			Name: '/obico-ml',
			State: 'running',
			Status: 'Up 4 days',
			Config: { Image: 'thespaghettidetective/obico-server:latest', Env: ['OCTOPRINT_URL=http://octoprint-mk4'], Labels: {}, ExposedPorts: { '3334/tcp': {} } },
			HostConfig: {},
			NetworkSettings: { Ports: {}, Networks: { printers_default: { IPAddress: '172.20.0.8' } } }
		},
		{
			Id: '1b2c3d4e5f6a'.padEnd(64, '0'),
			Name: '/nginx',
			State: 'running',
			Status: 'Up 4 days',
			Config: { Image: 'nginx:alpine', Env: [], Labels: {}, ExposedPorts: { '80/tcp': {} } },
			HostConfig: {},
			NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }, Networks: { bridge: { IPAddress: '172.17.0.2' } } }
		}
	];
	const requests = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://docker');
		requests.push(`${req.method} ${url.pathname}`);
		if (req.method !== 'GET') return sendJson(res, { message: 'Method not allowed (read-only proxy)' }, 403);
		const list = containers();
		if (url.pathname === '/containers/json') {
			return sendJson(res, list.map((c) => ({ Id: c.Id, Names: [c.Name], Image: c.Config.Image, State: c.State, Status: c.Status, NetworkSettings: { Networks: c.NetworkSettings.Networks } })));
		}
		const m = /^\/containers\/([^/]+)\/json$/.exec(url.pathname);
		const c = m && list.find((x) => x.Id === m[1] || x.Name === `/${m[1]}`);
		return c ? sendJson(res, c) : sendJson(res, { message: 'No such container' }, 404);
	});
	await listen(server, port);
	return { server, requests, close: () => new Promise((r) => server.close(r)) };
}

/** Arcane's API: two environments, read with a read-only key. */
export async function startMockArcane({ port, apiKey, voronPort }) {
	const environments = [
		{ id: '0', name: 'Local Docker', apiUrl: 'http://localhost:3552', status: 'online', enabled: true },
		{ id: 'e2', name: 'garage-pi', apiUrl: 'http://garage-pi.invalid:3553', status: 'online', enabled: true }
	];
	const containers = {
		'0': [
			{
				id: 'c3d4e5f6a1b2',
				names: ['/octoprint-voron'],
				image: 'octoprint/octoprint:1.11.8',
				state: 'running',
				status: 'Up 4 days',
				labels: { 'com.docker.compose.project': 'voron', 'com.docker.compose.service': 'octoprint' },
				ports: [{ ip: '0.0.0.0', privatePort: 80, publicPort: voronPort, type: 'tcp' }],
				networkSettings: { networks: { voron_default: { ipAddress: '172.21.0.2' } } }
			},
			{ id: 'aa11', names: ['/arcane'], image: 'ghcr.io/getarcaneapp/arcane:latest', state: 'running', status: 'Up', labels: {}, ports: [{ privatePort: 3552, publicPort: 3552, type: 'tcp' }] }
		],
		e2: [
			{
				id: 'f1e2d3c4b5a6',
				names: ['/octopi-ender5'],
				image: 'octoprint/octoprint:1.10.3',
				state: 'running',
				status: 'Up 9 days',
				labels: {},
				ports: [{ ip: '0.0.0.0', privatePort: 80, publicPort: 80, type: 'tcp' }],
				networkSettings: { networks: { bridge: { ipAddress: '172.17.0.3' } } }
			}
		]
	};
	const details = {
		c3d4e5f6a1b2: { config: { env: ['octoprint_ref=1.11.8'] }, hostConfig: { binds: ['/dev/ttyACM1:/dev/ttyACM0'] } },
		f1e2d3c4b5a6: { config: { env: ['octoprint_ref=1.10.3'] }, hostConfig: { devices: [{ pathOnHost: '/dev/ttyUSB0', pathInContainer: '/dev/ttyUSB0', cgroupPermissions: 'rwm' }] } }
	};
	const server = createServer((req, res) => {
		if (req.headers['x-api-key'] !== apiKey) return sendJson(res, { success: false, error: 'Invalid API key' }, 401);
		if (req.method !== 'GET') return sendJson(res, { success: false, error: 'read-only key' }, 403);
		const path = new URL(req.url, 'http://arcane').pathname;
		if (path === '/api/environments') return sendJson(res, { success: true, data: environments, pagination: { totalItems: environments.length } });
		let m = /^\/api\/environments\/([^/]+)\/containers$/.exec(path);
		if (m) {
			const list = containers[m[1]] ?? [];
			return sendJson(res, { success: true, data: list, pagination: { totalItems: list.length } });
		}
		m = /^\/api\/environments\/([^/]+)\/containers\/([^/]+)$/.exec(path);
		const c = m && (containers[m[1]] ?? []).find((x) => x.id === m[2]);
		if (c) return sendJson(res, { success: true, data: { ...c, ...(details[c.id] ?? {}) } });
		sendJson(res, { success: false, error: 'not found' }, 404);
	});
	await listen(server, port);
	return { server, close: () => new Promise((r) => server.close(r)) };
}

/** Answers `_octoprint._tcp.local` queries over unicast, like an OctoPi would over multicast. */
export async function startMdnsResponder({ port, instance, target, ip, servicePort, version }) {
	const SERVICE = '_octoprint._tcp.local';
	const fqdn = `${instance}.${SERVICE}`;
	const socket = createSocket('udp4');
	let queries = 0;
	socket.on('message', (msg, rinfo) => {
		let q;
		try {
			q = decodeMessage(msg);
		} catch {
			return;
		}
		if (!q.questions.some((x) => x.name.toLowerCase() === SERVICE || x.name.toLowerCase() === fqdn.toLowerCase())) return;
		queries++;
		socket.send(
			encodeMessage({
				flags: 0x8400,
				answers: [{ name: SERVICE, type: TYPE.PTR, class: 1, ttl: 4500, data: fqdn }],
				additionals: [
					{ name: fqdn, type: TYPE.SRV, class: 0x8001, ttl: 120, data: { priority: 0, weight: 0, port: servicePort, target } },
					{ name: fqdn, type: TYPE.TXT, class: 0x8001, ttl: 4500, data: { path: '/', version, api: '0.1', model: 'Raspberry Pi 4 Model B Rev 1.4' } },
					{ name: target, type: TYPE.A, class: 0x8001, ttl: 120, data: ip }
				]
			}),
			rinfo.port,
			rinfo.address
		);
	});
	await new Promise((r) => socket.bind(port, '127.0.0.1', r));
	return { queries: () => queries, close: () => new Promise((r) => socket.close(r)) };
}

/** Forwards a TCP port, to simulate a container's published port moving. */
export async function startForwarder({ port, to }) {
	const sockets = new Set();
	const server = createTcpServer((client) => {
		const upstream = connect(to, '127.0.0.1');
		sockets.add(client).add(upstream);
		client.pipe(upstream).pipe(client);
		const done = () => (client.destroy(), upstream.destroy());
		client.on('error', done).on('close', done);
		upstream.on('error', done).on('close', done);
	});
	await listen(server, port);
	return {
		close: () => {
			for (const s of sockets) s.destroy();
			return new Promise((r) => server.close(r));
		}
	};
}
