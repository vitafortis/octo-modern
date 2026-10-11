// A small OctoPrint stand-in whose printer is powered by a mock smart plug, for the power
// tests and `pnpm e2e:power`. It answers the REST calls octo·modern makes (no push socket,
// so octo·modern polls it), prints for a few seconds with hot heaters, and cools down after.
// Without power the printer can't connect; losing power drops the connection.
import { createServer } from 'node:http';

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
export async function startMockOctoPrint({ port = 0, apiKey = 'mock-key', powered = () => true, printSeconds = 8, coolPerSecond = 0.25, connectMs = 600, host = '127.0.0.1' } = {}) {
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
		connects: 0
	};
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
		if (p === '/api/login') return sendJson(res, { error: 'no push in this mock' }, 403);
		if (p === '/api/currentuser') return sendJson(res, { name: 'admin', permissions: [], groups: [] });
		if (p === '/api/settings') return sendJson(res, { webcam: { webcamEnabled: false }, plugins: {}, temperature: { profiles: [] } });
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
	await new Promise((resolve) => server.listen(port, host, resolve));
	return {
		url: `http://${host}:${server.address().port}`,
		apiKey,
		state: s,
		close: () => {
			clearInterval(tick);
			server.closeAllConnections?.();
			return new Promise((resolve) => server.close(() => resolve()));
		}
	};
}
