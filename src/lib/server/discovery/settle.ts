/**
 * Address settling: a container or host can be reachable in several ways (published
 * port, container IP on a network, container name, mDNS host name). Probe them all
 * and make the first one that answers as OctoPrint the primary address.
 */
import { addressKey, urlFor, type CandidateAddress, type Fingerprint } from '#lib/discovery.ts';
import { fingerprintUrl } from './fingerprint.ts';
import { probe as tcpProbe } from './probe.ts';

export interface Address {
	host: string;
	port: number;
	label: string;
	/** Path prefix (mDNS `path=`). */
	path?: string;
}

export const NO_FINGERPRINT: Fingerprint = { confidence: 'none', version: null, apiVersion: null, appkeys: false, loginRequired: true, signals: [] };

export interface Settled {
	primary: Address;
	baseUrl: string;
	alternates: CandidateAddress[];
	reachable: boolean;
	fingerprint: Fingerprint;
}

export interface SettleDeps {
	probe?: (host: string, port: number) => Promise<boolean>;
	fingerprint?: (baseUrl: string) => Promise<Fingerprint>;
	/** At most this many reachable addresses are fingerprinted. */
	maxFingerprints?: number;
}

export const addressUrl = (a: Address) => urlFor(a.host, a.port, a.path);

export function uniqueAddresses(list: Address[]): Address[] {
	const seen = new Set<string>();
	return list.filter((a) => {
		const k = addressKey(addressUrl(a));
		return seen.has(k) ? false : (seen.add(k), true);
	});
}

const RANK = { confirmed: 2, possible: 1, none: 0 } as const;

export async function settle(addresses: Address[], deps: SettleDeps = {}): Promise<Settled> {
	const probe = deps.probe ?? ((h, p) => tcpProbe(h, p));
	const fingerprint = deps.fingerprint ?? ((url) => fingerprintUrl(url));
	const list = uniqueAddresses(addresses);
	if (!list.length) throw new Error('No address to settle');
	const reachable = await Promise.all(list.map((a) => probe(a.host, a.port).catch(() => false)));
	const open = list.map((a, i) => ({ a, i })).filter((x) => reachable[x.i]);

	let best: { i: number; fp: Fingerprint } | undefined;
	for (const { a, i } of open.slice(0, deps.maxFingerprints ?? 4)) {
		const fp = await fingerprint(addressUrl(a)).catch(() => NO_FINGERPRINT);
		if (!best || RANK[fp.confidence] > RANK[best.fp.confidence]) best = { i, fp };
		if (fp.confidence === 'confirmed') break;
	}
	const idx = best ? best.i : open.length ? open[0].i : 0;
	const primary = list[idx];
	return {
		primary,
		baseUrl: addressUrl(primary),
		alternates: list.filter((_, i) => i !== idx).map((a) => ({ url: addressUrl(a), label: a.label, reachable: reachable[list.indexOf(a)] })),
		reachable: reachable[idx],
		fingerprint: best?.fp ?? NO_FINGERPRINT
	};
}
