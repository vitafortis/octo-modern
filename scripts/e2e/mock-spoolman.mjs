// A stand-in for Spoolman (https://github.com/Donkie/Spoolman), REST API v1, for tests
// and screenshots. It keeps vendors, filaments and spools in memory and answers with
// Spoolman's own shapes:
//
//   GET  /api/v1/info                  { version, debug_mode, automatic_backups, data_dir, … }
//   GET  /api/v1/health                { status: "healthy" }
//   GET  /api/v1/vendor | /filament    lists
//   GET  /api/v1/spool                 list (allow_archived, filament.material, sort, limit, offset); X-Total-Count header
//   GET  /api/v1/spool/{id}            one spool; 404 { message }
//   PUT  /api/v1/spool/{id}/use        { use_length } or { use_weight } (exactly one, else 400) → the spool
//
// Like Spoolman, use_length is converted to weight with the filament's density and
// diameter, remaining_weight = initial_weight − used_weight, remaining_length from that.
// `auth` (e.g. "Bearer x") makes every request need that Authorization header, as a
// reverse proxy in front of Spoolman would.
//
//   node scripts/e2e/mock-spoolman.mjs [port]   # standalone, with demo spools
import { createServer } from 'node:http';

const iso = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const lengthToWeight = (mm, diameter, density) => Math.PI * (diameter / 2) ** 2 * mm * density / 1000;
const weightToLength = (g, diameter, density) => (g / density) * 1000 / (Math.PI * (diameter / 2) ** 2);

/** Demo inventory: a few vendors and filaments, spools with different fill levels. */
export function demoInventory() {
	const vendors = [
		{ id: 1, registered: '2026-01-04T10:00:00Z', name: 'Prusament', comment: null, empty_spool_weight: 201, external_id: null, extra: {} },
		{ id: 2, registered: '2026-01-04T10:00:00Z', name: 'Polymaker', comment: null, empty_spool_weight: 140, external_id: null, extra: {} },
		{ id: 3, registered: '2026-01-04T10:00:00Z', name: 'eSun', comment: null, empty_spool_weight: 224, external_id: null, extra: {} }
	];
	const f = (id, vendor, name, material, color_hex, price, density = 1.24, extra = {}) => ({
		id,
		registered: '2026-01-04T10:05:00Z',
		name,
		vendor: vendors.find((v) => v.id === vendor),
		material,
		price,
		density,
		diameter: 1.75,
		weight: 1000,
		spool_weight: vendors.find((v) => v.id === vendor).empty_spool_weight,
		article_number: null,
		comment: null,
		settings_extruder_temp: material === 'PETG' ? 240 : 215,
		settings_bed_temp: material === 'PETG' ? 85 : 60,
		color_hex,
		multi_color_hexes: null,
		multi_color_direction: null,
		external_id: null,
		extra: {},
		...extra
	});
	const filaments = [
		f(1, 1, 'Galaxy Black', 'PLA', '1b1b1f', 29.99),
		f(2, 1, 'Prusa Orange', 'PETG', 'f26722', 29.99, 1.27),
		f(3, 2, 'PolyTerra Cotton White', 'PLA', 'ece8df', 21.99),
		f(4, 2, 'PolyLite Teal', 'ASA', '1f8a8a', 32.5, 1.07),
		f(5, 3, 'Silk Rainbow', 'PLA', null, 26, 1.24, { multi_color_hexes: 'e63946,f4a261,2a9d8f,457b9d', multi_color_direction: 'longitudinal' }),
		f(6, 3, 'Fire Engine Red', 'PETG', 'c1121f', 19.99, 1.27)
	];
	const s = (id, filament, used, extra = {}) => ({ id, filament_id: filament, used_weight: used, ...extra });
	const spools = [
		s(1, 1, 312.4, { location: 'Shelf A', lot_nr: 'PM-2291', price: 29.99 }),
		s(2, 2, 120, { location: 'Shelf A' }),
		s(3, 3, 905.2, { location: 'Dry box', comment: 'Nearly empty' }),
		s(4, 4, 40, { location: 'Dry box', price: 32.5 }),
		s(5, 5, 455),
		s(6, 6, 0, { location: 'Shelf B' }),
		s(7, 1, 1000, { archived: true })
	];
	return { vendors, filaments, spools };
}

export async function startMockSpoolman({ port = 0, host = '127.0.0.1', auth = null, inventory = demoInventory() } = {}) {
	const { vendors, filaments } = inventory;
	/** Spool state: { id, filament_id, used_weight, initial_weight?, price?, location?, lot_nr?, comment?, archived?, first_used, last_used, registered } */
	const spools = inventory.spools.map((x) => ({ registered: '2026-02-01T09:00:00Z', first_used: null, last_used: null, archived: false, ...x }));
	/** Every /use call: { id, body }. */
	const uses = [];
	const requests = [];

	const spoolJson = (x) => {
		const filament = filaments.find((f) => f.id === x.filament_id);
		const initial = x.initial_weight ?? filament.weight ?? null;
		const remaining = initial != null ? Math.max(0, initial - x.used_weight) : null;
		return {
			id: x.id,
			registered: x.registered,
			first_used: x.first_used,
			last_used: x.last_used,
			filament,
			price: x.price ?? null,
			remaining_weight: remaining,
			initial_weight: initial,
			spool_weight: filament.spool_weight ?? null,
			used_weight: x.used_weight,
			remaining_length: remaining != null ? weightToLength(remaining, filament.diameter, filament.density) : null,
			used_length: weightToLength(x.used_weight, filament.diameter, filament.density),
			location: x.location ?? null,
			lot_nr: x.lot_nr ?? null,
			comment: x.comment ?? null,
			archived: !!x.archived,
			extra: {}
		};
	};

	const send = (res, status, body, headers = {}) => {
		res.writeHead(status, { 'content-type': 'application/json', ...headers });
		res.end(JSON.stringify(body));
	};

	const server = createServer((req, res) => {
		let raw = '';
		req.on('data', (d) => (raw += d));
		req.on('end', () => {
			const url = new URL(req.url, 'http://x');
			const path = url.pathname.replace(/\/+$/, '');
			requests.push({ method: req.method, path, headers: req.headers });
			if (auth && req.headers.authorization !== auth) return send(res, 401, { message: 'Unauthorized' });
			if (req.method === 'GET' && path === '/api/v1/info')
				return send(res, 200, { version: '0.22.1', debug_mode: false, automatic_backups: true, data_dir: '/home/app/.local/share/spoolman', logs_dir: '/home/app/.local/share/spoolman', backups_dir: '/home/app/.local/share/spoolman/backups', db_type: 'sqlite', git_commit: 'e3b4a1c', build_date: '2026-06-02T11:20:00Z' });
			if (req.method === 'GET' && path === '/api/v1/health') return send(res, 200, { status: 'healthy' });
			if (req.method === 'GET' && path === '/api/v1/vendor') return send(res, 200, vendors, { 'x-total-count': String(vendors.length) });
			if (req.method === 'GET' && path === '/api/v1/filament') return send(res, 200, filaments, { 'x-total-count': String(filaments.length) });
			if (req.method === 'GET' && path === '/api/v1/spool') {
				let list = spools.filter((x) => url.searchParams.get('allow_archived') === 'true' || !x.archived).map(spoolJson);
				const mat = url.searchParams.get('filament.material');
				if (mat) list = list.filter((x) => x.filament.material?.toLowerCase() === mat.toLowerCase());
				const sort = url.searchParams.get('sort');
				if (sort) {
					const [field, dir] = sort.split(',')[0].split(':');
					list.sort((a, b) => ((a[field] ?? 0) > (b[field] ?? 0) ? 1 : -1) * (dir === 'desc' ? -1 : 1));
				}
				const total = list.length;
				const offset = Number(url.searchParams.get('offset') ?? 0);
				const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
				list = list.slice(offset, limit != null ? offset + limit : undefined);
				return send(res, 200, list, { 'x-total-count': String(total) });
			}
			let m = /^\/api\/v1\/spool\/(\d+)$/.exec(path);
			if (m && req.method === 'GET') {
				const x = spools.find((s) => s.id === Number(m[1]));
				return x ? send(res, 200, spoolJson(x)) : send(res, 404, { message: `No spool with ID ${m[1]} found.` });
			}
			m = /^\/api\/v1\/spool\/(\d+)\/use$/.exec(path);
			if (m && req.method === 'PUT') {
				const x = spools.find((s) => s.id === Number(m[1]));
				if (!x) return send(res, 404, { message: `No spool with ID ${m[1]} found.` });
				let body;
				try {
					body = JSON.parse(raw || '{}');
				} catch {
					return send(res, 422, { detail: [{ loc: ['body'], msg: 'Invalid JSON', type: 'value_error.jsondecode' }] });
				}
				const hasLength = body.use_length != null;
				const hasWeight = body.use_weight != null;
				if (hasLength === hasWeight) return send(res, 400, { message: 'Only specify either use_weight or use_length.' });
				const filament = filaments.find((f) => f.id === x.filament_id);
				const grams = hasWeight ? Number(body.use_weight) : lengthToWeight(Number(body.use_length), filament.diameter, filament.density);
				x.used_weight = Math.max(0, x.used_weight + grams);
				x.first_used ??= iso();
				x.last_used = iso();
				uses.push({ id: x.id, body });
				return send(res, 200, spoolJson(x));
			}
			send(res, 404, { detail: 'Not Found' });
		});
	});
	await new Promise((r) => server.listen(port, host, r));
	const address = server.address();
	return {
		url: `http://${host}:${address.port}`,
		spools,
		uses,
		requests,
		spool: (id) => spoolJson(spools.find((s) => s.id === id)),
		close: () =>
			new Promise((r) => {
				server.closeAllConnections?.();
				server.close(() => r());
			})
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const m = await startMockSpoolman({ port: Number(process.argv[2] ?? 7912) });
	console.log(`mock Spoolman on ${m.url}`);
}
