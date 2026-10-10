/**
 * Network discovery for OctoPrint outside Docker (OctoPi on a Raspberry Pi, mostly):
 * mDNS browsing for `_octoprint._tcp`, and an admin-started subnet scan that opens
 * TCP connections to a range of addresses and fingerprints whatever answers.
 */
import { reverse } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { urlFor, type Candidate, type NetworkScan } from '#lib/discovery.ts';
import { discoveryEnv } from './config.ts';
import { fingerprintUrl } from './fingerprint.ts';
import { browse, type BrowseOptions, type MdnsService } from './mdns.ts';
import { mapLimit, probe } from './probe.ts';
import { settle, type Address, type SettleDeps } from './settle.ts';

export const MAX_HOSTS = 4096;
export const MAX_PROBES = 16_384;

const toInt = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const toIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/**
 * Parses what an admin types: CIDRs (`192.168.4.0/24`), single addresses or host names,
 * and last-octet ranges (`192.168.4.20-40`), separated by commas or spaces.
 */
export function parseTargets(input: string): string[] {
	const out: string[] = [];
	const push = (h: string) => {
		if (!out.includes(h)) out.push(h);
		if (out.length > MAX_HOSTS) throw new Error(`That's more than ${MAX_HOSTS} addresses; scan a smaller range (a /20 at most).`);
	};
	for (const part of input.split(/[\s,;]+/).filter(Boolean)) {
		let m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(part);
		if (m) {
			if (!isIPv4(m[1])) throw new Error(`“${part}” isn't a valid IPv4 network`);
			const bits = Number(m[2]);
			if (bits > 32) throw new Error(`“${part}” isn't a valid IPv4 network`);
			if (bits < 20) throw new Error(`“${part}” is too large to scan; use /20 or smaller.`);
			const size = 2 ** (32 - bits);
			const base = toInt(m[1]) & (bits === 0 ? 0 : (~(size - 1) >>> 0));
			// Skip the network and broadcast addresses, except for /31 and /32.
			const [first, last] = size > 2 ? [base + 1, base + size - 2] : [base, base + size - 1];
			for (let n = first; n <= last; n++) push(toIp(n >>> 0));
			continue;
		}
		m = /^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$/.exec(part);
		if (m) {
			const [a, b] = [Number(m[2]), Number(m[3])];
			if (a > b || b > 255 || !isIPv4(`${m[1]}${a}`)) throw new Error(`“${part}” isn't a valid range`);
			for (let n = a; n <= b; n++) push(`${m[1]}${n}`);
			continue;
		}
		if (isIPv4(part) || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(part)) {
			push(part.toLowerCase());
			continue;
		}
		throw new Error(`“${part}” isn't an address, range or CIDR`);
	}
	if (!out.length) throw new Error('Enter a subnet such as 192.168.1.0/24, a range or addresses');
	return out;
}

/** `80, 5000, 443` or `5151-5153`. */
export function parsePorts(input: string): number[] {
	const out: number[] = [];
	for (const part of (input.trim() || '80, 5000, 443').split(/[\s,;]+/).filter(Boolean)) {
		const m = /^(\d+)(?:-(\d+))?$/.exec(part);
		if (!m) throw new Error(`“${part}” isn't a port`);
		const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
		if (a < 1 || b > 65535 || a > b) throw new Error(`“${part}” isn't a valid port range`);
		for (let p = a; p <= b; p++) if (!out.includes(p)) out.push(p);
		if (out.length > 32) throw new Error('Scan at most 32 ports at a time');
	}
	return out;
}

const PORT_ORDER = [80, 443, 5000];
const portRank = (p: number) => (PORT_ORDER.includes(p) ? PORT_ORDER.indexOf(p) : 10 + p);

async function reverseName(ip: string): Promise<string | null> {
	if (!isIPv4(ip)) return null;
	try {
		const names = await Promise.race([reverse(ip), new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 800))]);
		return names[0]?.replace(/\.$/, '') ?? null;
	} catch {
		return null;
	}
}

export interface SubnetScanOptions {
	concurrency?: number;
	timeoutMs?: number;
	probe?: (host: string, port: number) => Promise<boolean>;
	fingerprint?: SettleDeps['fingerprint'];
	reverseDns?: boolean;
}

export async function scanSubnet(targetsInput: string, portsInput: string, opts: SubnetScanOptions = {}): Promise<NetworkScan> {
	const started = Date.now();
	const hosts = parseTargets(targetsInput);
	const ports = parsePorts(portsInput);
	if (hosts.length * ports.length > MAX_PROBES) throw new Error(`That's ${hosts.length * ports.length} probes; scan fewer addresses or ports (at most ${MAX_PROBES}).`);
	const timeoutMs = opts.timeoutMs ?? 700;
	const tcp = opts.probe ?? ((h: string, p: number) => probe(h, p, timeoutMs, { cached: false }));
	const pairs = hosts.flatMap((host) => ports.map((port) => ({ host, port })));
	const open = (await mapLimit(pairs, opts.concurrency ?? 128, async (x) => ((await tcp(x.host, x.port).catch(() => false)) ? x : null))).filter((x): x is { host: string; port: number } => !!x);

	// 80 and 443 on one host are usually the same OctoPrint (OctoPi's proxy); any other port
	// may be another instance (several printers on one Pi or Docker host), so it stays separate.
	const byHost = new Map<string, number[]>();
	for (const { host, port } of open) {
		const group = port === 80 || port === 443 ? `${host}|web` : `${host}|${port}`;
		byHost.set(group, [...(byHost.get(group) ?? []), port]);
	}
	const fp = opts.fingerprint ?? ((url: string) => fingerprintUrl(url, { timeoutMs: 2500 }));

	const candidates = (
		await mapLimit([...byHost], 16, async ([group, hostPorts]): Promise<Candidate | null> => {
			const host = group.slice(0, group.lastIndexOf('|'));
			const addresses: Address[] = hostPorts.sort((a, b) => portRank(a) - portRank(b)).map((port) => ({ host, port, label: `port ${port}` }));
			const settled = await settle(addresses, { probe: async () => true, fingerprint: fp, maxFingerprints: addresses.length });
			if (settled.fingerprint.confidence === 'none') return null;
			const name = opts.reverseDns === false ? null : await reverseName(host);
			return {
				key: `subnet:${settled.baseUrl}`,
				name: `${name?.split('.')[0] ?? host}${settled.primary.port === 80 || settled.primary.port === 443 ? '' : `:${settled.primary.port}`}`,
				baseUrl: settled.baseUrl,
				alternates: settled.alternates,
				reachable: true,
				insecureTls: settled.primary.port === 443 || undefined,
				fingerprint: settled.fingerprint,
				source: { kind: 'subnet', ref: settled.baseUrl, label: 'subnet scan' },
				serial: [],
				notes: name ? [`Reverse DNS: ${name}`] : []
			};
		})
	).filter((c): c is Candidate => !!c);
	return {
		kind: 'subnet',
		durationMs: Date.now() - started,
		scope: `${targetsInput.trim()} · ports ${ports.join(', ')}`,
		probed: pairs.length,
		candidates: candidates.sort((a, b) => a.baseUrl.localeCompare(b.baseUrl, undefined, { numeric: true }))
	};
}

/** Candidates from mDNS services: their A records (or whoever answered), plus the .local name. */
export async function mdnsCandidates(services: MdnsService[], deps: SettleDeps = {}): Promise<Candidate[]> {
	return mapLimit(services, 8, async (s) => {
		const port = s.port ?? 80;
		const path = s.txt.path && s.txt.path !== '/' ? s.txt.path : undefined;
		const ips = s.addresses.length ? s.addresses : s.from;
		// OctoPi advertises OctoPrint's own port (5000), which listens on localhost only; its
		// HAProxy serves it on 80/443. So the advertised port is tried first, then those.
		const ports = [...new Set([port, 80, 443])];
		const v4 = ips.filter(isIPv4);
		const addresses: Address[] = [
			...v4.map((ip) => ({ host: ip, port, path, label: 'mDNS address' })),
			...(s.host ? [{ host: s.host, port, path, label: 'mDNS name' }] : []),
			...ports.slice(1).flatMap((p) => v4.map((ip) => ({ host: ip, port: p, path, label: `port ${p} (OctoPi proxy)` })))
		];
		const settled = addresses.length ? await settle(addresses, deps) : null;
		const name = s.instance.replace(/^OctoPrint instance on /i, '') || s.instance;
		const fp = settled?.fingerprint;
		const signals = [`mDNS: _octoprint._tcp “${s.instance}”`, ...(fp?.signals ?? [])];
		const notes: string[] = [];
		if (s.txt.model) notes.push(`Model: ${[s.txt.vendor, s.txt.model].filter(Boolean).join(' ')}`);
		if (s.txt.u) notes.push('Advertises HTTP basic auth; octo·modern doesn’t send basic-auth credentials.');
		return {
			key: `mdns:${s.instance}`,
			name,
			baseUrl: settled?.baseUrl ?? urlFor(s.host ?? 'unknown', port, path),
			alternates: settled?.alternates ?? [],
			reachable: settled?.reachable ?? false,
			fingerprint: {
				// The advertisement itself is OctoPrint-specific.
				confidence: 'confirmed',
				version: fp?.version ?? s.txt.version ?? null,
				apiVersion: fp?.apiVersion ?? s.txt.api ?? null,
				appkeys: fp?.appkeys ?? false,
				loginRequired: fp?.loginRequired ?? true,
				signals
			},
			source: { kind: 'mdns', ref: s.instance, label: 'mDNS' },
			serial: [],
			notes
		} satisfies Candidate;
	});
}

export async function scanMdns(opts: BrowseOptions & { settle?: SettleDeps } = {}): Promise<NetworkScan> {
	const started = Date.now();
	try {
		const { services, responders, interfaces } = await browse('_octoprint._tcp.local', { target: discoveryEnv.mdnsTarget, ...opts });
		const candidates = await mdnsCandidates(services, opts.settle);
		return {
			kind: 'mdns',
			durationMs: Date.now() - started,
			scope: `_octoprint._tcp.local${interfaces.length ? ` on ${interfaces.join(', ')}` : ''}`,
			probed: responders,
			candidates
		};
	} catch (err) {
		return { kind: 'mdns', durationMs: Date.now() - started, scope: '_octoprint._tcp.local', probed: 0, error: (err as Error).message, candidates: [] };
	}
}
