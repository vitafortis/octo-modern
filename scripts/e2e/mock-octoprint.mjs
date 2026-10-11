// A small OctoPrint stand-in whose printer is powered by a mock smart plug, for the power
// tests and `pnpm e2e:power`. It answers the REST calls octo·modern makes (no push socket,
// so octo·modern polls it, unless `push: true`), prints for a few seconds with hot heaters,
// and cools down after. Without power the printer can't connect; losing power drops the connection.
//
// `bedVisualizer: { … }` adds the Bed Visualizer plugin (OctoPrint-BedLevelVisualizer):
// its settings (`plugins.bedlevelvisualizer`: command, stored_mesh, stored_mesh_x/y,
// mesh_timestamp, save_mesh), and a probe run when `@BEDLEVELVISUALIZER` arrives as G-code:
// `{ processing: true }`, then `{ mesh, bed }` on the push socket after `delayMs`. `uiSaves`
// also writes the mesh into the settings (as the plugin's own web UI does when it's open).
// `nextMesh(run)` makes each probe run's mesh; `fail: 'message'` makes the next run report an error.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const sendJson = (res, body, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const readBody = (req) =>
	new Promise((resolve) => {
		let b = '';
		req.on('data', (d) => (b += d));
		req.on('end', () => resolve(b));
	});

const ROOM = 22;

/**
 * - `powered()`: whether the printer has power (the mock plug's state)
 * - `printSeconds`: how long a print runs; `coolPerSecond`: fraction of the gap to room temperature lost per second
 * - `connectMs`: how long connecting takes
 */
/** A demo mesh: a gentle bowl with a raised back-left corner, `n`×`n`, values as the plugin stores them (strings). */
export function demoMesh(n = 7, { tilt = 0, bow = 0.08, seed = 1 } = {}) {
	const rows = [];
	for (let r = 0; r < n; r++) {
		const row = [];
		for (let c = 0; c < n; c++) {
			const u = c / (n - 1) - 0.5;
			const v = r / (n - 1) - 0.5;
			const corner = u < -0.3 && v > 0.3 ? 0.06 : 0;
			const noise = Math.sin((r + 1) * (c + 2) * seed) * 0.008;
			row.push((bow * (u * u + v * v) * 2 - bow * 0.4 + tilt * u + corner + noise).toFixed(3));
		}
		rows.push(row);
	}
	return rows;
}

// --- a minimal websocket server (RFC 6455 text frames), enough for OctoPrint's push socket ---

function wsAccept(req, socket) {
	const key = req.headers['sec-websocket-key'];
	const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
	socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
	const send = (obj) => {
		if (socket.destroyed) return;
		const data = Buffer.from(JSON.stringify(obj));
		const len = data.length;
		const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), Buffer.from([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255])]);
		socket.write(Buffer.concat([head, data]));
	};
	let buf = Buffer.alloc(0);
	const messages = [];
	socket.on('data', (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		while (buf.length >= 2) {
			const op = buf[0] & 15;
			let len = buf[1] & 127;
			let off = 2;
			if (len === 126) (len = buf.readUInt16BE(2)), (off = 4);
			else if (len === 127) (len = Number(buf.readBigUInt64BE(2))), (off = 10);
			const masked = buf[1] & 128;
			const need = off + (masked ? 4 : 0) + len;
			if (buf.length < need) return;
			const mask = masked ? buf.subarray(off, off + 4) : null;
			const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
			if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
			buf = buf.subarray(need);
			if (op === 8) {
				socket.end(Buffer.from([0x88, 0]));
				return;
			}
			if (op === 1) messages.push(payload.toString('utf8'));
		}
	});
	return { send, messages, socket };
}

export async function startMockOctoPrint({ port = 0, apiKey = 'mock-key', powered = () => true, printSeconds = 8, coolPerSecond = 0.25, connectMs = 600, host = '127.0.0.1', push = false, bedVisualizer = null } = {}) {
	const s = {
		/** 'Offline' | 'Connecting' | 'Operational' | 'Printing' | 'Offline after error' */
		state: 'Offline',
		error: null,
		tool: ROOM,
		bed: ROOM,
		toolTarget: 0,
		bedTarget: 0,
		job: null,
		startedAt: 0,
		requests: [],
		connects: 0,
		/** G-code received over /api/printer/command. */
		commands: [],
		/** Bodies POSTed to /api/settings. */
		settingsWrites: [],
		/** Bed Visualizer plugin state (null: not installed). */
		blv: bedVisualizer
			? {
					command: bedVisualizer.command ?? 'G28\nG29 T',
					stored_mesh: bedVisualizer.mesh ?? [],
					stored_mesh_x: bedVisualizer.x ?? [],
					stored_mesh_y: bedVisualizer.y ?? [],
					stored_mesh_z_height: 2,
					mesh_timestamp: bedVisualizer.timestamp ?? '',
					save_mesh: bedVisualizer.saveMesh ?? true,
					timeout: bedVisualizer.timeout ?? 1800,
					runs: 0,
					fail: bedVisualizer.fail ?? null
				}
			: null,
		pushClients: 0
	};
	const sockets = new Set();
	const pushAll = (obj) => {
		for (const ws of sockets) ws.send(obj);
	};
	const bed = bedVisualizer?.bed ?? { type: 'rectangular', x_min: 10, x_max: 240, y_min: 10, y_max: 200, z_min: 0, z_max: 2 };

	/** The probe coordinates the plugin's UI stores with a mesh (evenly over the bed, rounded). */
	function axesFor(mesh) {
		const n = mesh[0]?.length ?? 0;
		const m = mesh.length;
		const even = (k, lo, hi) => Array.from({ length: k }, (_, i) => Math.round(k === 1 ? lo : lo + (i / (k - 1)) * (hi - lo)));
		return { stored_mesh_x: even(n, bed.x_min, bed.x_max), stored_mesh_y: even(m, bed.y_min, bed.y_max) };
	}
	if (s.blv && s.blv.stored_mesh.length && !bedVisualizer.x) Object.assign(s.blv, axesFor(s.blv.stored_mesh));

	/** A probe run, as the plugin does it after `@BEDLEVELVISUALIZER`. */
	function probe() {
		const b = s.blv;
		pushAll({ plugin: { plugin: 'bedlevelvisualizer', data: { processing: true } } });
		setTimeout(() => {
			if (b.fail) {
				const message = b.fail;
				b.fail = null;
				pushAll({ plugin: { plugin: 'bedlevelvisualizer', data: { error: message } } });
				return;
			}
			b.runs++;
			const mesh = bedVisualizer.nextMesh ? bedVisualizer.nextMesh(b.runs) : demoMesh(7, { seed: b.runs + 1 });
			pushAll({ plugin: { plugin: 'bedlevelvisualizer', data: { mesh, bed } } });
			if (bedVisualizer.uiSaves) Object.assign(b, { stored_mesh: mesh, ...axesFor(mesh), mesh_timestamp: new Date().toLocaleString('en-GB') });
		}, bedVisualizer.delayMs ?? 1500).unref?.();
	}
	const connected = () => s.state === 'Operational' || s.state === 'Printing';
	let last = Date.now();
	const tick = setInterval(() => {
		const now = Date.now();
		const dt = (now - last) / 1000;
		last = now;
		if (!powered() && s.state !== 'Offline' && s.state !== 'Offline after error') {
			// Power cut: the serial connection drops.
			s.state = 'Offline after error';
			s.error = 'Connection to the printer was lost (no power?)';
			s.job = null;
		}
		if (s.state === 'Printing' && now - s.startedAt >= printSeconds * 1000) {
			s.state = 'Operational';
			s.toolTarget = 0;
			s.bedTarget = 0;
			s.job.done = true;
		}
		const approach = (v, target) => {
			const goal = target > 0 && powered() ? target : ROOM;
			const rate = goal > v ? 0.9 : coolPerSecond;
			const next = v + (goal - v) * Math.min(1, rate * dt);
			return Math.abs(next - goal) < 0.3 ? goal : next;
		};
		s.tool = approach(s.tool, s.toolTarget);
		s.bed = approach(s.bed, s.bedTarget);
	}, 200);
	tick.unref?.();
	const pushTick = setInterval(() => {
		if (!sockets.size) return;
		pushAll({ current: currentFrame() });
	}, 1000);
	pushTick.unref?.();

	const flags = () => ({
		operational: connected(),
		printing: s.state === 'Printing',
		paused: false,
		pausing: false,
		cancelling: false,
		resuming: false,
		finishing: false,
		error: s.state === 'Offline after error',
		closedOrError: !connected(),
		ready: s.state === 'Operational',
		sdReady: false
	});
	const round = (v) => Math.round(v * 10) / 10;
	const currentFrame = () => ({
		state: { text: s.state, flags: flags(), error: s.error ?? '' },
		job: { file: s.job ? { name: s.job.path.split('/').pop(), path: s.job.path, display: s.job.path.split('/').pop(), origin: 'local' } : { name: null, path: null, display: null, origin: null } },
		progress: { completion: null, printTime: null, printTimeLeft: null },
		currentZ: null,
		temps: connected() ? [{ time: Math.floor(Date.now() / 1000), tool0: { actual: round(s.tool), target: s.toolTarget }, bed: { actual: round(s.bed), target: s.bedTarget } }] : [],
		logs: [],
		busyFiles: []
	});

	function startPrint(path) {
		s.job = { path, done: false };
		s.state = 'Printing';
		s.startedAt = Date.now();
		s.toolTarget = 215;
		s.bedTarget = 60;
		// Already warm, as after the heat-up: keeps the tests short.
		s.tool = 205;
		s.bed = 58;
	}

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://x');
		const body = await readBody(req);
		s.requests.push({ method: req.method, path: url.pathname });
		if (url.pathname.startsWith('/__mock/')) {
			if (url.pathname === '/__mock/print') {
				if (!connected()) return sendJson(res, { error: 'not connected' }, 409);
				startPrint(url.searchParams.get('file') ?? 'benchy.gcode');
				return sendJson(res, { ok: true });
			}
			if (url.pathname === '/__mock/state') return sendJson(res, { ...s, requests: undefined });
			if (url.pathname === '/__mock/bedmesh' && s.blv) {
				// A mesh probed from OctoPrint's own UI (saved into the plugin's settings).
				const b = JSON.parse(body || '{}');
				if (b.mesh) Object.assign(s.blv, { stored_mesh: b.mesh, ...axesFor(b.mesh), ...(b.x ? { stored_mesh_x: b.x } : {}), ...(b.y ? { stored_mesh_y: b.y } : {}), mesh_timestamp: b.timestamp ?? new Date().toLocaleString('en-GB') });
				if (b.fail !== undefined) s.blv.fail = b.fail;
				if (b.command !== undefined) s.blv.command = b.command;
				return sendJson(res, { ok: true });
			}
			if (url.pathname === '/__mock/heat') {
				s.tool = Number(url.searchParams.get('tool') ?? s.tool);
				s.bed = Number(url.searchParams.get('bed') ?? s.bed);
				return sendJson(res, { ok: true });
			}
			return sendJson(res, { error: 'unknown' }, 404);
		}
		if (req.headers['x-api-key'] !== apiKey) return sendJson(res, { error: 'Invalid API key' }, 403);
		const p = url.pathname;
		if (p === '/api/version') return sendJson(res, { api: '0.1', server: '1.11.2', text: 'OctoPrint 1.11.2' });
		if (p === '/api/login') return push ? sendJson(res, { name: 'admin', session: 'mock-session' }) : sendJson(res, { error: 'no push in this mock' }, 403);
		if (p === '/api/currentuser') return sendJson(res, { name: 'admin', permissions: [], groups: [] });
		if (p === '/api/settings') {
			if (req.method === 'POST') {
				const b = JSON.parse(body || '{}');
				s.settingsWrites.push(b);
				const blv = b.plugins?.bedlevelvisualizer;
				if (blv && s.blv) Object.assign(s.blv, blv);
				return sendJson(res, {});
			}
			const { runs: _r, fail: _f, ...blv } = s.blv ?? {};
			return sendJson(res, { webcam: { webcamEnabled: false }, plugins: s.blv ? { bedlevelvisualizer: blv } : {}, temperature: { profiles: [] } });
		}
		if (p === '/api/printer/command' && req.method === 'POST') {
			if (!connected()) return sendJson(res, { error: 'Printer is not operational' }, 409);
			const b = JSON.parse(body || '{}');
			const cmds = Array.isArray(b.commands) ? b.commands : b.command ? [b.command] : [];
			s.commands.push(...cmds);
			if (s.blv && cmds[0] === '@BEDLEVELVISUALIZER') probe();
			return res.writeHead(204).end();
		}
		if (p === '/api/printer') {
			if (!connected()) return sendJson(res, { error: 'Printer is not operational' }, 409);
			return sendJson(res, {
				state: { text: s.state, flags: flags(), error: s.error ?? '' },
				temperature: { tool0: { actual: round(s.tool), target: s.toolTarget, offset: 0 }, bed: { actual: round(s.bed), target: s.bedTarget, offset: 0 } }
			});
		}
		if (p === '/api/job') {
			if (req.method === 'POST') {
				const b = JSON.parse(body || '{}');
				if (b.command === 'cancel' && s.state === 'Printing') {
					s.state = 'Operational';
					s.toolTarget = s.bedTarget = 0;
					return res.writeHead(204).end();
				}
				return sendJson(res, { error: 'Printer is not printing' }, 409);
			}
			const elapsed = s.state === 'Printing' ? (Date.now() - s.startedAt) / 1000 : s.job?.done ? printSeconds : null;
			const file = s.job ? { name: s.job.path.split('/').pop(), path: s.job.path, display: s.job.path.split('/').pop(), origin: 'local', size: 123456, date: 1760000000 } : { name: null, path: null, display: null, origin: null, size: null, date: null };
			return sendJson(res, {
				job: { file, estimatedPrintTime: s.job ? printSeconds : null, filament: s.job ? { tool0: { length: 1234, volume: 3 } } : null, user: s.job ? 'admin' : null },
				progress: { completion: elapsed == null ? null : Math.min(100, (elapsed / printSeconds) * 100), printTime: elapsed == null ? null : Math.round(elapsed), printTimeLeft: s.state === 'Printing' ? Math.max(0, Math.round(printSeconds - elapsed)) : null, printTimeLeftOrigin: 'estimate', filepos: null },
				state: s.state
			});
		}
		if (p === '/api/connection') {
			if (req.method === 'POST') {
				const b = JSON.parse(body || '{}');
				if (b.command === 'connect') {
					s.connects++;
					s.state = 'Connecting';
					s.error = null;
					setTimeout(() => {
						if (s.state !== 'Connecting') return;
						if (powered()) s.state = 'Operational';
						else {
							s.state = 'Offline after error';
							s.error = 'Failed to autodetect serial port, please set it manually.';
						}
					}, connectMs).unref?.();
					return res.writeHead(204).end();
				}
				if (b.command === 'disconnect') {
					s.state = 'Offline';
					s.error = null;
					return res.writeHead(204).end();
				}
				return sendJson(res, { error: 'bad command' }, 400);
			}
			return sendJson(res, {
				current: { state: s.state, port: connected() ? '/dev/ttyACM0' : null, baudrate: connected() ? 115200 : null, printerProfile: '_default' },
				options: { ports: ['/dev/ttyACM0'], baudrates: [115200, 250000], printerProfiles: [{ id: '_default', name: 'Default' }], portPreference: null, baudratePreference: null, printerProfilePreference: '_default', autoconnect: false }
			});
		}
		if (p === '/api/files' || p === '/api/files/local') {
			if (req.method === 'GET') return sendJson(res, { files: [{ name: 'benchy.gcode', path: 'benchy.gcode', display: 'benchy.gcode', type: 'machinecode', typePath: ['machinecode', 'gcode'], origin: 'local', size: 123456, date: 1760000000, refs: {} }], free: 1e10, total: 2e10 });
		}
		const sel = /^\/api\/files\/local\/(.+)$/.exec(p);
		if (sel && req.method === 'POST') {
			const b = JSON.parse(body || '{}');
			if (b.command === 'select') {
				if (b.print) {
					if (s.state !== 'Operational') return sendJson(res, { error: 'Printer is not operational' }, 409);
					startPrint(decodeURIComponent(sel[1]));
				}
				return res.writeHead(204).end();
			}
		}
		if (sel && req.method === 'GET') return sendJson(res, { name: 'benchy.gcode', path: 'benchy.gcode', origin: 'local', size: 123456, prints: {} });
		sendJson(res, { error: 'Not found' }, 404);
	});
	server.on('upgrade', (req, socket) => {
		if (!push || !req.url.startsWith('/sockjs/websocket')) return socket.destroy();
		const ws = wsAccept(req, socket);
		sockets.add(ws);
		s.pushClients = sockets.size;
		socket.on('close', () => {
			sockets.delete(ws);
			s.pushClients = sockets.size;
		});
		socket.on('error', () => sockets.delete(ws));
		ws.send({ connected: { version: '1.11.2', display_version: '1.11.2', apikey: null } });
		// The first update right away, so the session counts as open.
		setTimeout(() => ws.send({ current: currentFrame() }), 100);
	});
	await new Promise((resolve) => server.listen(port, host, resolve));
	return {
		url: `http://${host}:${server.address().port}`,
		apiKey,
		state: s,
		/** Sends a raw push message to every connected socket (e.g. a plugin message). */
		push: pushAll,
		close: () => {
			clearInterval(tick);
			clearInterval(pushTick);
			for (const ws of sockets) ws.socket.destroy();
			server.closeAllConnections?.();
			return new Promise((resolve) => server.close(() => resolve()));
		}
	};
}
