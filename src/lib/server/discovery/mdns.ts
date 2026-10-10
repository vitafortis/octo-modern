/**
 * A minimal multicast DNS (RFC 6762) / DNS-SD (RFC 6763) browser in plain Node, for
 * OctoPrint's `_octoprint._tcp.local` advertisement (OctoPi announces it by default,
 * with TXT `path`, `version`, `api` and `model`).
 *
 * The query goes out from an ephemeral port, which makes it a "legacy unicast" query:
 * responders answer straight back to that port, so no listener on 5353 is needed and
 * nothing conflicts with Avahi/Bonjour on the host. Multicast only crosses one L2
 * segment, so inside Docker it needs host networking or a macvlan/ipvlan network.
 */
import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

export const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 } as const;
const CLASS_IN = 1;

export interface Question {
	name: string;
	type: number;
	/** Ask for a unicast reply (the QU bit). */
	unicast?: boolean;
}

export type RecordData = string | { priority: number; weight: number; port: number; target: string } | Record<string, string> | Buffer;

export interface ResourceRecord {
	name: string;
	type: number;
	/** Class without the cache-flush bit. */
	class: number;
	ttl: number;
	data: RecordData;
}

export interface Message {
	id: number;
	flags: number;
	questions: Question[];
	answers: ResourceRecord[];
}

// --- encoding ---------------------------------------------------------------------

function encodeName(name: string): Buffer {
	const parts = name.replace(/\.$/, '').split('.').filter(Boolean);
	const bufs = parts.map((p) => {
		const b = Buffer.from(p, 'utf8');
		if (b.length > 63) throw new Error(`DNS label too long: ${p}`);
		return Buffer.concat([Buffer.from([b.length]), b]);
	});
	return Buffer.concat([...bufs, Buffer.from([0])]);
}

function u16(n: number) {
	const b = Buffer.alloc(2);
	b.writeUInt16BE(n);
	return b;
}

function encodeData(r: ResourceRecord): Buffer {
	switch (r.type) {
		case TYPE.A:
			return Buffer.from(String(r.data).split('.').map(Number));
		case TYPE.PTR:
			return encodeName(String(r.data));
		case TYPE.SRV: {
			const s = r.data as { priority: number; weight: number; port: number; target: string };
			return Buffer.concat([u16(s.priority), u16(s.weight), u16(s.port), encodeName(s.target)]);
		}
		case TYPE.TXT: {
			const entries = Object.entries(r.data as Record<string, string>).map(([k, v]) => Buffer.from(v === '' ? k : `${k}=${v}`, 'utf8'));
			if (!entries.length) return Buffer.from([0]);
			return Buffer.concat(entries.flatMap((e) => [Buffer.from([e.length]), e]));
		}
		default:
			return Buffer.isBuffer(r.data) ? r.data : Buffer.alloc(0);
	}
}

/** Encodes a DNS message (no name compression; fine for queries and test responders). */
export function encodeMessage(m: Partial<Message> & { answers?: ResourceRecord[]; additionals?: ResourceRecord[] }): Buffer {
	const questions = m.questions ?? [];
	const answers = m.answers ?? [];
	const additionals = m.additionals ?? [];
	const header = Buffer.concat([u16(m.id ?? 0), u16(m.flags ?? 0), u16(questions.length), u16(answers.length), u16(0), u16(additionals.length)]);
	const qs = questions.map((q) => Buffer.concat([encodeName(q.name), u16(q.type), u16(CLASS_IN | (q.unicast ? 0x8000 : 0))]));
	const rr = (r: ResourceRecord) => {
		const data = encodeData(r);
		const ttl = Buffer.alloc(4);
		ttl.writeUInt32BE(r.ttl >>> 0);
		return Buffer.concat([encodeName(r.name), u16(r.type), u16(r.class || CLASS_IN), ttl, u16(data.length), data]);
	};
	return Buffer.concat([header, ...qs, ...answers.map(rr), ...additionals.map(rr)]);
}

export function encodeQuery(questions: Question[], id = 0): Buffer {
	return encodeMessage({ id, flags: 0, questions });
}

// --- decoding ---------------------------------------------------------------------

/** Reads a (possibly compressed) name at `offset`; returns it and where the name ends in place. */
function readName(buf: Buffer, offset: number): { name: string; end: number } {
	const labels: string[] = [];
	let pos = offset;
	let end = -1;
	for (let jumps = 0; ; ) {
		if (pos >= buf.length) throw new Error('DNS name runs past the packet');
		const len = buf[pos];
		if (len === 0) {
			if (end === -1) end = pos + 1;
			break;
		}
		if ((len & 0xc0) === 0xc0) {
			if (pos + 1 >= buf.length) throw new Error('Truncated DNS pointer');
			if (++jumps > 32) throw new Error('DNS compression loop');
			if (end === -1) end = pos + 2;
			pos = ((len & 0x3f) << 8) | buf[pos + 1];
			continue;
		}
		if ((len & 0xc0) !== 0) throw new Error('Unsupported DNS label type');
		if (pos + 1 + len > buf.length) throw new Error('DNS label runs past the packet');
		labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
		pos += 1 + len;
	}
	return { name: labels.join('.'), end };
}

function decodeTxt(data: Buffer): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < data.length; ) {
		const len = data[i];
		const s = data.toString('utf8', i + 1, Math.min(data.length, i + 1 + len));
		i += 1 + len;
		if (!s) continue;
		const eq = s.indexOf('=');
		const k = (eq === -1 ? s : s.slice(0, eq)).toLowerCase();
		if (!(k in out)) out[k] = eq === -1 ? '' : s.slice(eq + 1);
	}
	return out;
}

function ipv6(data: Buffer): string {
	const parts: string[] = [];
	for (let i = 0; i < 16; i += 2) parts.push(data.readUInt16BE(i).toString(16));
	return parts.join(':');
}

export function decodeMessage(buf: Buffer): Message {
	if (buf.length < 12) throw new Error('DNS packet too short');
	const id = buf.readUInt16BE(0);
	const flags = buf.readUInt16BE(2);
	const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
	let pos = 12;
	const questions: Question[] = [];
	for (let i = 0; i < counts[0]; i++) {
		const { name, end } = readName(buf, pos);
		if (end + 4 > buf.length) throw new Error('Truncated DNS question');
		const cls = buf.readUInt16BE(end + 2);
		questions.push({ name, type: buf.readUInt16BE(end), unicast: (cls & 0x8000) !== 0 });
		pos = end + 4;
	}
	const answers: ResourceRecord[] = [];
	const total = counts[1] + counts[2] + counts[3];
	for (let i = 0; i < total; i++) {
		const { name, end } = readName(buf, pos);
		if (end + 10 > buf.length) throw new Error('Truncated DNS record');
		const type = buf.readUInt16BE(end);
		const cls = buf.readUInt16BE(end + 2) & 0x7fff;
		const ttl = buf.readUInt32BE(end + 4);
		const len = buf.readUInt16BE(end + 8);
		const start = end + 10;
		if (start + len > buf.length) throw new Error('DNS record data runs past the packet');
		const raw = buf.subarray(start, start + len);
		let data: RecordData = Buffer.from(raw);
		if (type === TYPE.A && len === 4) data = [...raw].join('.');
		else if (type === TYPE.AAAA && len === 16) data = ipv6(raw);
		else if (type === TYPE.PTR) data = readName(buf, start).name;
		else if (type === TYPE.SRV && len >= 7) data = { priority: raw.readUInt16BE(0), weight: raw.readUInt16BE(2), port: raw.readUInt16BE(4), target: readName(buf, start + 6).name };
		else if (type === TYPE.TXT) data = decodeTxt(raw);
		answers.push({ name, type, class: cls, ttl, data });
		pos = start + len;
	}
	return { id, flags, questions, answers };
}

// --- browsing ---------------------------------------------------------------------

export interface MdnsService {
	/** Instance name, e.g. "OctoPrint instance on octopi". */
	instance: string;
	/** SRV target, e.g. "octopi.local". */
	host: string | null;
	port: number | null;
	addresses: string[];
	txt: Record<string, string>;
	/** Who answered (useful when A records are missing). */
	from: string[];
}

const lower = (s: string) => s.toLowerCase().replace(/\.$/, '');

/** Folds DNS-SD records into services of `serviceType`. Pure, for tests. */
export function collectServices(records: { record: ResourceRecord; from: string }[], serviceType: string): MdnsService[] {
	const type = lower(serviceType);
	const services = new Map<string, MdnsService>();
	const byName = (n: string) => records.filter((r) => lower(r.record.name) === lower(n));
	for (const { record, from } of records) {
		if (record.type !== TYPE.PTR || lower(record.name) !== type || record.ttl === 0) continue;
		const instanceFqdn = String(record.data);
		const key = lower(instanceFqdn);
		const s = services.get(key) ?? { instance: instanceFqdn.slice(0, Math.max(0, instanceFqdn.length - type.length - 1)) || instanceFqdn, host: null, port: null, addresses: [], txt: {}, from: [] };
		if (!s.from.includes(from)) s.from.push(from);
		services.set(key, s);
	}
	for (const [fqdn, s] of services) {
		for (const { record } of byName(fqdn)) {
			if (record.type === TYPE.SRV && typeof record.data === 'object' && 'port' in record.data) {
				s.host = (record.data.target as string).replace(/\.$/, '');
				s.port = record.data.port as number;
			} else if (record.type === TYPE.TXT && typeof record.data === 'object' && !Buffer.isBuffer(record.data) && !('port' in record.data)) {
				Object.assign(s.txt, record.data);
			}
		}
		if (s.host) {
			for (const { record } of byName(s.host)) {
				if ((record.type === TYPE.A || record.type === TYPE.AAAA) && typeof record.data === 'string' && !s.addresses.includes(record.data)) s.addresses.push(record.data);
			}
		}
	}
	return [...services.values()];
}

function ipv4Interfaces(): string[] {
	return Object.values(networkInterfaces())
		.flat()
		.filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
		.map((a) => a.address);
}

export interface BrowseOptions {
	timeoutMs?: number;
	/** Where to send the query (tests point this at a unicast responder). */
	target?: { host: string; port: number };
	/** Interfaces to send from; default: every non-internal IPv4 interface. */
	interfaces?: string[];
}

/** Sends PTR queries for `serviceType` and collects answers for `timeoutMs`. */
export async function browse(serviceType = '_octoprint._tcp.local', opts: BrowseOptions = {}): Promise<{ services: MdnsService[]; responders: number; interfaces: string[] }> {
	const timeoutMs = opts.timeoutMs ?? 2500;
	const target = opts.target ?? { host: '224.0.0.251', port: 5353 };
	const multicast = !opts.target;
	const interfaces = multicast ? (opts.interfaces ?? ipv4Interfaces()) : [];
	const records: { record: ResourceRecord; from: string }[] = [];
	const responders = new Set<string>();
	const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true });

	socket.on('message', (msg, rinfo) => {
		try {
			const m = decodeMessage(msg);
			if (!(m.flags & 0x8000)) return; // a query, not a response
			responders.add(rinfo.address);
			for (const record of m.answers) records.push({ record, from: rinfo.address });
		} catch {
			// Malformed packets from other devices are ignored.
		}
	});

	await new Promise<void>((resolve, reject) => {
		socket.once('error', reject);
		socket.bind(0, () => {
			socket.off('error', reject);
			resolve();
		});
	});
	socket.on('error', () => {});

	const sendOne = (packet: Buffer) => new Promise<void>((resolve) => socket.send(packet, target.port, target.host, () => resolve()));
	// The outgoing interface applies when the packet is actually sent, so each send is
	// awaited before switching to the next interface.
	const send = async (questions: Question[]) => {
		const packet = encodeQuery(questions);
		if (!multicast) return sendOne(packet);
		try {
			socket.setMulticastTTL(255);
		} catch {}
		for (const iface of interfaces.length ? interfaces : [undefined]) {
			try {
				if (iface) socket.setMulticastInterface(iface);
				await sendOne(packet);
			} catch {}
		}
	};

	try {
		await send([{ name: serviceType, type: TYPE.PTR, unicast: true }]);
		// A second query a little later catches responders that missed the first.
		await new Promise((r) => setTimeout(r, Math.min(800, timeoutMs / 3)));
		await send([{ name: serviceType, type: TYPE.PTR, unicast: true }]);
		await new Promise((r) => setTimeout(r, Math.min(800, timeoutMs / 3)));
		// Ask instances that came without SRV/TXT/A in the additionals for them directly.
		const partial = collectServices(records, serviceType).filter((s) => !s.port || !s.addresses.length);
		if (partial.length) {
			await send(partial.flatMap((s): Question[] => [
				{ name: `${s.instance}.${serviceType}`, type: TYPE.SRV, unicast: true },
				{ name: `${s.instance}.${serviceType}`, type: TYPE.TXT, unicast: true },
				...(s.host ? [{ name: s.host, type: TYPE.A, unicast: true }] : [])
			]));
		}
		await new Promise((r) => setTimeout(r, Math.max(0, timeoutMs - 2 * Math.min(800, timeoutMs / 3))));
	} finally {
		socket.close();
	}
	return { services: collectServices(records, serviceType), responders: responders.size, interfaces };
}
