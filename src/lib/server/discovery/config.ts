/**
 * Discovery settings: Docker endpoints and Arcane from the environment, plus what
 * admins save on the Discover page (kv `discovery`, Arcane keys sealed separately).
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '../crypto.ts';
import { deleteKv, getKv, setKv } from '../store.ts';
import type { ArcaneManager, DiscoverySettings } from '#lib/discovery.ts';

function list(value: string | undefined): string[] {
	return (value ?? '')
		.split(/[,;\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** The local Docker socket, when there is one and nothing else is configured. */
function defaultDockerHosts(): string[] {
	if (process.env.DOCKER_HOST) return [process.env.DOCKER_HOST];
	const candidates = [
		'/var/run/docker.sock',
		`${process.env.HOME}/.docker/run/docker.sock`,
		`${process.env.HOME}/.orbstack/run/docker.sock`,
		`${process.env.HOME}/.colima/default/docker.sock`
	];
	const found = candidates.find((p) => existsSync(p));
	return found ? [`unix://${found}`] : [];
}

export const discoveryEnv = {
	/** `OCM_DOCKER_HOSTS=tcp://docker-proxy:2375,unix:///var/run/docker.sock`; `none` turns the default off. */
	dockerHosts: process.env.OCM_DOCKER_HOSTS === 'none' ? [] : process.env.OCM_DOCKER_HOSTS ? list(process.env.OCM_DOCKER_HOSTS) : defaultDockerHosts(),
	/** Our own container name, when hostname/IP matching can't find it (custom hostname, macvlan…). */
	selfContainer: process.env.OCM_SELF_CONTAINER?.trim() || undefined,
	/** Development/tests: send mDNS queries to this `host:port` (a unicast responder) instead of multicast. */
	mdnsTarget: (() => {
		const m = /^(.+):(\d+)$/.exec(process.env.OCM_MDNS_TARGET?.trim() ?? '');
		return m ? { host: m[1], port: Number(m[2]) } : undefined;
	})(),
	arcane: process.env.OCM_ARCANE_URL
		? { url: process.env.OCM_ARCANE_URL.trim(), apiKey: process.env.OCM_ARCANE_API_KEY ?? '', name: process.env.OCM_ARCANE_NAME?.trim() || 'Arcane' }
		: undefined
};

const KEY = 'discovery';
const DEFAULTS: DiscoverySettings = { dockerHosts: [], subnet: { cidr: '', ports: '80, 5000, 443' } };

interface Stored extends DiscoverySettings {
	arcane?: { id: string; name: string; url: string }[];
}

function stored(): Stored {
	const s = getKv<Partial<Stored>>(KEY, {});
	return { ...DEFAULTS, ...s, subnet: { ...DEFAULTS.subnet, ...s.subnet } };
}

export function getDiscoverySettings(): DiscoverySettings {
	const { dockerHosts, subnet } = stored();
	return { dockerHosts, subnet };
}

/** Validates and saves the editable settings (Docker endpoints, the subnet form). */
export function saveDiscoverySettings(patch: Partial<DiscoverySettings>): DiscoverySettings {
	const s = stored();
	if (patch.dockerHosts) {
		s.dockerHosts = [...new Set(patch.dockerHosts.map((h) => h.trim()).filter(Boolean))].map((h) => {
			if (!/^(tcp|http|https|unix):\/\//.test(h)) throw new Error(`“${h}” isn't a Docker endpoint: use tcp://host:2375 or unix:///var/run/docker.sock`);
			return h;
		});
	}
	if (patch.subnet) s.subnet = { cidr: String(patch.subnet.cidr ?? '').slice(0, 200), ports: String(patch.subnet.ports ?? '').slice(0, 200) };
	setKv(KEY, s);
	return getDiscoverySettings();
}

export function dockerEndpoints(): string[] {
	return [...new Set([...discoveryEnv.dockerHosts, ...stored().dockerHosts])];
}

// --- Arcane --------------------------------------------------------------------

export const ENV_ARCANE_ID = 'env-arcane';
const keyName = (id: string) => `discovery.arcane-key:${id}`;

function savedArcaneKey(id: string): string | undefined {
	const sealed = getKv<string | null>(keyName(id), null);
	return sealed ? decrypt(sealed, `arcane:${id}`) : undefined;
}

export function arcaneKey(id: string): string | undefined {
	return id === ENV_ARCANE_ID ? discoveryEnv.arcane?.apiKey || undefined : savedArcaneKey(id);
}

export function listArcane(): ArcaneManager[] {
	const env = discoveryEnv.arcane;
	const fromEnv: ArcaneManager[] = env ? [{ id: ENV_ARCANE_ID, name: env.name, url: env.url, hasKey: !!env.apiKey, fromEnv: true }] : [];
	return [...fromEnv, ...(stored().arcane ?? []).map((m) => ({ ...m, hasKey: !!getKv<string | null>(keyName(m.id), null) }))];
}

export function normalizeArcaneUrl(raw: string): string {
	let s = raw.trim();
	if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
	const u = new URL(s);
	return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}`;
}

/** Adds or updates a saved Arcane (an empty key keeps the stored one). */
export function saveArcane(input: { id?: string; name: string; url: string; apiKey?: string }): ArcaneManager {
	const s = stored();
	const all = s.arcane ?? [];
	const id = input.id && all.some((m) => m.id === input.id) ? input.id : randomUUID();
	const entry = { id, name: input.name.trim() || 'Arcane', url: normalizeArcaneUrl(input.url) };
	s.arcane = [...all.filter((m) => m.id !== id), entry];
	setKv(KEY, s);
	if (input.apiKey) setKv(keyName(id), encrypt(input.apiKey.trim(), `arcane:${id}`));
	return listArcane().find((m) => m.id === id)!;
}

export function removeArcane(id: string): boolean {
	const s = stored();
	const before = s.arcane?.length ?? 0;
	s.arcane = (s.arcane ?? []).filter((m) => m.id !== id);
	setKv(KEY, s);
	deleteKv(keyName(id));
	return s.arcane.length < before;
}

// --- where saved printers came from ------------------------------------------

/**
 * The discovery source of printers added from Discover (`kind` + `ref`), so a later
 * scan recognizes the same container even after its address changed.
 */
const SOURCES = 'discovery.sources';

export function printerSources(): Record<string, { kind: string; ref: string }> {
	return getKv<Record<string, { kind: string; ref: string }>>(SOURCES, {});
}

export function setPrinterSource(printerId: string, source: { kind: string; ref: string } | null) {
	const all = printerSources();
	if (source) all[printerId] = { kind: source.kind, ref: source.ref };
	else delete all[printerId];
	setKv(SOURCES, all);
}
