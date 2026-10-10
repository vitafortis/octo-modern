/**
 * Types and small helpers for Discover, shared by the server and the browser.
 * Discovery never handles API keys: candidates are addresses, and a key only
 * arrives through OctoPrint's Application Keys flow (or a paste) at import time.
 */

export type DiscoverySourceKind = 'docker' | 'arcane' | 'mdns' | 'subnet';

/** What an unauthenticated look at a server says about it. */
export interface Fingerprint {
	/** `confirmed`: an OctoPrint-only marker answered; `possible`: only generic hints. */
	confidence: 'confirmed' | 'possible' | 'none';
	/** OctoPrint version, when the server, its mDNS record or its image tells. */
	version: string | null;
	apiVersion: string | null;
	/** The Application Keys plugin answered its probe, so keys can be requested. */
	appkeys: boolean;
	/** OctoPrint wants a login (modern default); false when /api/version answered without a key. */
	loginRequired: boolean;
	/** Human-readable reasons, e.g. "GET /plugin/appkeys/probe → 204". */
	signals: string[];
}

/** pg·modern-style network explanation: how octo·modern reaches a container. */
export interface SelfNetworks {
	inContainer: boolean;
	/** Our own container name, when found in this Docker host's container list. */
	container?: string;
	networks: string[];
}

export interface NetworkPath {
	/** Networks the OctoPrint container is attached to. */
	networks: string[];
	/** Of those, the ones octo·modern is attached to as well. */
	shared: string[];
	/** Host ports published for OctoPrint's port. */
	published: { host: string; port: number }[];
	via: 'shared-network' | 'published-port' | 'host-network' | 'none';
	/** A network octo·modern could join to reach it. */
	join?: string;
	/** The container port that could be published instead. */
	publish?: number;
}

/** A serial device mapped into an OctoPrint container (which printer it owns). */
export interface SerialDevice {
	/** Path on the Docker host, e.g. /dev/ttyACM0 or /dev/serial/by-id/usb-Prusa… */
	host: string;
	/** Path inside the container. */
	container: string;
	via: 'device' | 'bind' | 'privileged';
}

export interface CandidateAddress {
	url: string;
	label: string;
	reachable?: boolean;
}

export interface Candidate {
	/** Unique per scan source; used to re-identify a candidate later (relink, saved matching). */
	key: string;
	name: string;
	/** Best address: the first that answered as OctoPrint, else the first reachable one. */
	baseUrl: string;
	alternates: CandidateAddress[];
	reachable: boolean;
	/** https with a certificate we couldn't check (443 on a LAN): import with Verify TLS off. */
	insecureTls?: boolean;
	fingerprint: Fingerprint;
	source: {
		kind: DiscoverySourceKind;
		/** Stable identity: `<endpoint>#<container>`, `<arcane>·<env>·<container>`, mDNS instance, or the address. */
		ref: string;
		/** Where it came from, for the badge: endpoint, Arcane environment, "mDNS", "subnet scan". */
		label: string;
	};
	container?: { id: string; name: string; image: string; state: string; status: string; project?: string; service?: string };
	serial: SerialDevice[];
	network?: NetworkPath;
	notes: string[];
	/** The saved printer this corresponds to. `addressChanged`: saved on an address this scan doesn't use. */
	saved?: { id: string; name: string; baseUrl: string; addressChanged: boolean };
}

export interface DockerScan {
	endpoint: string;
	error?: string;
	self?: SelfNetworks;
	inspected?: number;
	candidates: Candidate[];
}

export interface ArcaneManager {
	id: string;
	name: string;
	url: string;
	hasKey: boolean;
	/** From OCM_ARCANE_URL / OCM_ARCANE_API_KEY; not editable in the UI. */
	fromEnv?: boolean;
}

export interface ArcaneScan {
	manager: ArcaneManager;
	error?: string;
	environments: { id: string; name: string; host: string; error?: string; inspected?: number; self?: SelfNetworks; candidates: Candidate[] }[];
}

export interface NetworkScan {
	kind: 'mdns' | 'subnet';
	durationMs: number;
	/** What was looked at, e.g. "_octoprint._tcp.local" or "192.168.4.0/24 · ports 80, 5000, 443". */
	scope: string;
	/** Hosts × ports probed (subnet) or responders heard (mDNS). */
	probed: number;
	error?: string;
	candidates: Candidate[];
}

export interface DiscoverySettings {
	/** Extra Docker endpoints (tcp://host:2375), in addition to OCM_DOCKER_HOSTS. */
	dockerHosts: string[];
	/** Remembered subnet-scan form. */
	subnet: { cidr: string; ports: string };
}

/** Docker endpoints from the environment, shown read-only next to saved ones. */
export interface DiscoveryConfig {
	settings: DiscoverySettings;
	envDockerHosts: string[];
	managers: ArcaneManager[];
}

/** State of an Application Keys request, as the browser sees it (never the key itself). */
export interface AppKeyRequestState {
	id: string;
	baseUrl: string;
	state: 'pending' | 'approved' | 'denied' | 'expired' | 'error';
	/** OctoPrint's own approval page (as OctoPrint addressed it). */
	authDialog: string | null;
	message?: string;
	startedAt: number;
	/** Seconds until octo·modern stops waiting. */
	expiresIn: number;
}

/** Compose change that attaches octo·modern to networks it doesn't share yet. */
export function joinNetworksSnippet(networks: string[]): string {
	const list = [...new Set(networks)].sort();
	return [
		'services:',
		'  octo-modern:',
		'    networks:',
		'      - default',
		...list.map((n) => `      - ${n}`),
		'',
		'networks:',
		...list.flatMap((n) => [`  ${n}:`, '    external: true'])
	].join('\n');
}

/** `scheme://host:port/path` with default ports dropped and the host lowercased, for comparing addresses. */
export function addressKey(url: string): string {
	try {
		const u = new URL(url);
		const port = u.port || (u.protocol === 'https:' ? '443' : '80');
		return `${u.hostname.toLowerCase()}:${port}${u.pathname.replace(/\/+$/, '')}`;
	} catch {
		return url.toLowerCase().replace(/\/+$/, '');
	}
}

/** Base URL for host + port: https on 443, port omitted when it's the scheme's default. */
export function urlFor(host: string, port: number, path = ''): string {
	const https = port === 443;
	const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
	const p = (https && port === 443) || (!https && port === 80) ? '' : `:${port}`;
	const prefix = path && path !== '/' ? `/${path.replace(/^\/+|\/+$/g, '')}` : '';
	return `${https ? 'https' : 'http'}://${h}${p}${prefix}`;
}
