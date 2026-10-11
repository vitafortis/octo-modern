// Local stand-ins for smart plugs, for the tests and `pnpm e2e:power`: Shelly Gen1 and Gen2
// (with Basic and SHA-256 Digest logins), Tasmota, Home Assistant and a generic HTTP switch.
// Each listens on 127.0.0.1 only; nothing here talks to a real device.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const sendJson = (res, body, status = 200, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
const readBody = (req) =>
	new Promise((resolve) => {
		let b = '';
		req.on('data', (d) => (b += d));
		req.on('end', () => resolve(b));
	});

function parseAuthParams(header) {
	const out = {};
	const re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi;
	let m;
	while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] ?? m[3];
	return out;
}

/**
 * Starts one mock plug.
 * - `kind`: 'shelly1' | 'shelly2' | 'tasmota' | 'homeassistant' | 'http'
 * - `auth`: `{ username, password }` (Shelly, Tasmota, HTTP) or `{ token }` (Home Assistant)
 * - `on`: initial state; `watts(on)`: the draw it reports; `onChange(on)`: called on every switch
 */
export async function startMockPlug({ kind, port = 0, auth = null, on = false, watts = (o) => (o ? 42.5 : 0), onChange = () => {}, host = '127.0.0.1' }) {
	const state = { on, energyWh: 1234.5, requests: [], failNext: 0 };
	const set = (v) => {
		if (state.on !== v) {
			state.on = v;
			onChange(v);
		}
	};
	const realm = 'shellyplus1pm-e2e';
	const nonces = new Set();

	function basicOk(req) {
		if (!auth) return true;
		const h = req.headers.authorization ?? '';
		return h === `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
	}

	function digestOk(req, method, uri) {
		if (!auth) return true;
		const h = req.headers.authorization ?? '';
		if (!h.startsWith('Digest ')) return false;
		const p = parseAuthParams(h.slice(7));
		if (!nonces.has(p.nonce) || p.username !== auth.username || p.uri !== uri) return false;
		const H = (s) => createHash('sha256').update(s).digest('hex');
		const ha1 = H(`${auth.username}:${realm}:${auth.password}`);
		const ha2 = H(`${method}:${uri}`);
		return p.response === H(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
	}

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://x');
		const body = await readBody(req);
		state.requests.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body });
		if (state.failNext > 0) {
			state.failNext--;
			return sendJson(res, { error: 'mock failure' }, 500);
		}
		const meter = () => ({ power: watts(state.on), total: Math.round(state.energyWh * 60), voltage: 230.1 });

		if (kind === 'shelly1') {
			if (url.pathname === '/shelly') return sendJson(res, { type: 'SHPLG-S', mac: 'E2E000000001', auth: !!auth, fw: '20230913-112003/v1.14.0-gcb84623' });
			if (!basicOk(req)) return sendJson(res, { error: 'unauthorized' }, 401, { 'www-authenticate': 'Basic realm="shelly"' });
			if (url.pathname === '/status') return sendJson(res, { relays: [{ ison: state.on, has_timer: false }], meters: [meter()] });
			if (url.pathname === '/relay/0') {
				const turn = url.searchParams.get('turn');
				if (turn === 'on' || turn === 'off') set(turn === 'on');
				return sendJson(res, { ison: state.on });
			}
			return sendJson(res, { error: 'not found' }, 404);
		}

		if (kind === 'shelly2') {
			if (url.pathname === '/shelly') return sendJson(res, { id: 'shellyplusplugs-e2e', mac: 'E2E000000002', model: 'SNPL-00112EU', gen: 2, fw_id: '20240819-074343/1.4.2', auth_en: !!auth });
			if (!digestOk(req, req.method, url.pathname + url.search)) {
				const nonce = randomBytes(8).toString('hex');
				nonces.add(nonce);
				return sendJson(res, { code: 401, message: 'unauthorized' }, 401, { 'www-authenticate': `Digest qop="auth", realm="${realm}", nonce="${nonce}", algorithm=SHA-256` });
			}
			if (url.pathname === '/rpc/Switch.GetStatus' && url.searchParams.get('id') === '0') {
				return sendJson(res, { id: 0, source: 'HTTP_in', output: state.on, apower: watts(state.on), voltage: 230.1, current: 0.2, aenergy: { total: state.energyWh }, temperature: { tC: 38.2 } });
			}
			if (url.pathname === '/rpc/Switch.Set' && url.searchParams.get('id') === '0') {
				const was = state.on;
				set(url.searchParams.get('on') === 'true');
				return sendJson(res, { was_on: was });
			}
			return sendJson(res, { code: 404, message: 'No handler' }, 404);
		}

		if (kind === 'tasmota') {
			if (url.pathname !== '/cm') return sendJson(res, { error: 'not found' }, 404);
			if (auth && (url.searchParams.get('user') !== auth.username || url.searchParams.get('password') !== auth.password)) {
				return sendJson(res, { WARNING: 'Need user=<username>&password=<password>' });
			}
			const cmnd = (url.searchParams.get('cmnd') ?? '').trim();
			const m = /^power(\d?)\s*(on|off|toggle|1|0)?$/i.exec(cmnd);
			if (m) {
				const v = (m[2] ?? '').toLowerCase();
				if (v === 'on' || v === '1') set(true);
				else if (v === 'off' || v === '0') set(false);
				else if (v === 'toggle') set(!state.on);
				return sendJson(res, { POWER: state.on ? 'ON' : 'OFF' });
			}
			if (/^status\s+8$/i.test(cmnd)) {
				return sendJson(res, { StatusSNS: { Time: new Date().toISOString().slice(0, 19), ENERGY: { TotalStartTime: '2026-01-01T00:00:00', Total: state.energyWh / 1000, Yesterday: 0.1, Today: 0.05, Power: watts(state.on), Voltage: 231, Current: 0.18 } } });
			}
			return sendJson(res, { Command: 'Unknown' });
		}

		if (kind === 'homeassistant') {
			if (auth && req.headers.authorization !== `Bearer ${auth.token}`) return sendJson(res, { message: 'Unauthorized' }, 401);
			const entity = 'switch.printer_plug';
			if (req.method === 'GET' && url.pathname === `/api/states/${entity}`) {
				return sendJson(res, { entity_id: entity, state: state.on ? 'on' : 'off', attributes: { friendly_name: 'Printer plug' } });
			}
			if (req.method === 'GET' && url.pathname === '/api/states/sensor.printer_plug_power') {
				return sendJson(res, { entity_id: 'sensor.printer_plug_power', state: String(watts(state.on)), attributes: { unit_of_measurement: 'W' } });
			}
			if (req.method === 'GET' && url.pathname === '/api/states/sensor.printer_plug_energy') {
				return sendJson(res, { entity_id: 'sensor.printer_plug_energy', state: String(state.energyWh / 1000), attributes: { unit_of_measurement: 'kWh' } });
			}
			const svc = /^\/api\/services\/switch\/turn_(on|off)$/.exec(url.pathname);
			if (req.method === 'POST' && svc) {
				if (JSON.parse(body || '{}').entity_id !== entity) return sendJson(res, { message: 'bad entity' }, 400);
				set(svc[1] === 'on');
				return sendJson(res, []);
			}
			return sendJson(res, { message: 'Entity not found.' }, 404);
		}

		if (kind === 'http') {
			if (auth && !basicOk(req)) return sendJson(res, { error: 'unauthorized' }, 401, { 'www-authenticate': 'Basic realm="relay"' });
			if (url.pathname === '/relay/on' && req.method === 'POST') {
				set(true);
				return sendJson(res, { ok: true });
			}
			if (url.pathname === '/relay/off' && req.method === 'POST') {
				set(false);
				return sendJson(res, { ok: true });
			}
			if (url.pathname === '/relay/state') return sendJson(res, { relay: state.on ? 'ON' : 'OFF' });
			return sendJson(res, { error: 'not found' }, 404);
		}
		sendJson(res, { error: 'unknown kind' }, 500);
	});
	await new Promise((resolve) => server.listen(port, host, resolve));
	const url = `http://${host}:${server.address().port}`;
	return {
		url,
		state,
		set,
		close: () => {
			server.closeAllConnections?.();
			return new Promise((resolve) => server.close(() => resolve()));
		},
		server
	};
}
