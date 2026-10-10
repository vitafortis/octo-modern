/**
 * Where octo·modern sits relative to an OctoPrint container: on a shared Docker
 * network, through a published port, or with no route (and which network fixes that).
 * Adapted from pg·modern.
 */
import { hostname, networkInterfaces } from 'node:os';
import { IN_CONTAINER } from '../config.ts';
import { discoveryEnv } from './config.ts';
import type { NetworkPath, SelfNetworks } from '#lib/discovery.ts';

/** A container's networks, normalised from the Docker or Arcane API. */
export interface ContainerNetworks {
	id: string;
	name: string;
	/** Network name → IP on that network ('' when unknown). */
	networks: Record<string, string>;
	published: { host: string; port: number }[];
	running: boolean;
}

const NO_ROUTE = new Set(['none']);

function ownAddresses(): Set<string> {
	const out = new Set<string>();
	for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (!a.internal) out.add(a.address);
	return out;
}

/**
 * Finds our own container in a list: by OCM_SELF_CONTAINER, by hostname (Docker's
 * default is the short container id), or by one of this process's addresses.
 */
export function findSelf(containers: ContainerNetworks[], opts: { inContainer?: boolean; named?: string; host?: string; addresses?: Set<string> } = {}): SelfNetworks {
	const inContainer = opts.inContainer ?? IN_CONTAINER;
	const named = (opts.named ?? discoveryEnv.selfContainer)?.toLowerCase();
	if (!inContainer && !named) return { inContainer: false, networks: [] };
	const host = (opts.host ?? hostname()).toLowerCase();
	const addrs = opts.addresses ?? ownAddresses();
	const self =
		(named ? containers.find((c) => c.name.toLowerCase() === named || c.id.toLowerCase().startsWith(named)) : undefined) ??
		containers.find((c) => host.length >= 12 && c.id.toLowerCase().startsWith(host)) ??
		containers.find((c) => Object.values(c.networks).some((ip) => ip && addrs.has(ip)));
	return self
		? { inContainer: true, container: self.name, networks: Object.keys(self.networks).filter((n) => !NO_ROUTE.has(n)).sort() }
		: { inContainer: true, networks: [] };
}

export function networkPath(target: ContainerNetworks, self: SelfNetworks, internalPort: number): NetworkPath {
	const networks = Object.keys(target.networks).sort();
	const published = target.published;
	if (networks.includes('host')) return { networks, shared: [], published, via: 'host-network' };
	const shared = self.container ? networks.filter((n) => self.networks.includes(n) && !NO_ROUTE.has(n)) : [];
	if (shared.length) return { networks, shared, published, via: 'shared-network' };
	if (published.length) return { networks, shared, published, via: 'published-port' };
	const joinable = networks.filter((n) => !['bridge', 'host', 'none'].includes(n));
	return { networks, shared, published, via: 'none', join: self.container ? joinable[0] : undefined, publish: internalPort };
}
