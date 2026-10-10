/**
 * OctoPrint containers in every environment an Arcane instance manages, read through
 * its API with a read-only key (environments:list, containers:list, containers:read;
 * projects:list / projects:read only label the results).
 */
import type { ArcaneManager, ArcaneScan, Candidate } from '#lib/discovery.ts';
import { arcaneKey, listArcane } from './config.ts';
import { containerCandidate, detectOctoPrint, envMap, type NormalizedContainer } from './containers.ts';
import { findSelf } from './network.ts';
import { mapLimit } from './probe.ts';

export class ArcaneClient {
	private base: string;
	private apiKey: string;

	constructor(base: string, apiKey: string) {
		this.base = base.replace(/\/+$/, '');
		this.apiKey = apiKey;
	}

	async get<T>(path: string): Promise<T> {
		let res: Response;
		try {
			res = await fetch(`${this.base}/api${path}`, { headers: { 'X-API-Key': this.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
		} catch (err) {
			const cause = (err as { cause?: { code?: string; message?: string } }).cause;
			throw new Error(`Could not reach Arcane at ${this.base} (${cause?.code ?? cause?.message ?? (err as Error).message})`);
		}
		const text = await res.text();
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new Error(`Arcane returned ${res.status} (not JSON) for ${path}`);
		}
		if (!res.ok) {
			const b = body as { error?: string; message?: string; detail?: string; title?: string };
			const reason = b.error ?? b.detail ?? b.message ?? b.title ?? res.statusText;
			throw new Error(res.status === 401 || res.status === 403 ? `Arcane rejected the API key (${reason})` : `Arcane ${res.status}: ${reason}`);
		}
		return body as T;
	}

	/** Arcane wraps responses as { success, data }. */
	async data<T>(path: string): Promise<T> {
		const body = await this.get<{ data?: unknown }>(path);
		return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
	}

	/** Reads every page of a paginated list. */
	async list<T>(path: string): Promise<T[]> {
		const out: T[] = [];
		const sep = path.includes('?') ? '&' : '?';
		while (out.length < 10_000) {
			const body = await this.get<{ data?: T[]; pagination?: { totalItems?: number } }>(`${path}${sep}start=${out.length}&limit=100`);
			const page = Array.isArray(body) ? (body as T[]) : (body.data ?? []);
			out.push(...page);
			const total = Array.isArray(body) ? undefined : body.pagination?.totalItems;
			if (!page.length || (total !== undefined ? out.length >= total : page.length < 100)) break;
		}
		return out;
	}
}

type ArcaneEnvironment = { id: string; name?: string; apiUrl?: string; status?: string; enabled?: boolean };

/** Arcane's container DTO (camelCase); detail responses add config/hostConfig/mounts. */
type ArcaneContainer = {
	id: string;
	name?: string;
	names?: string[];
	image: string;
	state?: string | { status?: string };
	status?: string;
	labels?: Record<string, string> | null;
	ports?: { ip?: string; privatePort: number; publicPort?: number; type?: string }[] | null;
	networkSettings?: { networks?: Record<string, { ipAddress?: string }> | null } | null;
	config?: { env?: string[] | null; exposedPorts?: Record<string, object> | null } | null;
	hostConfig?: {
		networkMode?: string;
		privileged?: boolean;
		devices?: { pathOnHost?: string; pathInContainer?: string; PathOnHost?: string; PathInContainer?: string }[] | null;
		binds?: string[] | null;
	} | null;
	mounts?: { type?: string; source?: string; destination?: string }[] | null;
};

const nameOf = (c: ArcaneContainer) => (c.name ?? c.names?.[0] ?? c.id.slice(0, 12)).replace(/^\//, '');
const stateOf = (c: ArcaneContainer) => (typeof c.state === 'string' ? c.state : (c.state?.status ?? c.status ?? 'unknown'));

export function normalizeArcane(c: ArcaneContainer, envHost: string): NormalizedContainer {
	const binds = (c.mounts ?? []).filter((m) => m.type === 'bind' && m.source && m.destination).map((m) => ({ source: m.source!, destination: m.destination! }));
	for (const b of c.hostConfig?.binds ?? []) {
		const [source, destination] = b.split(':');
		if (source && destination && !binds.some((m) => m.source === source)) binds.push({ source, destination });
	}
	const published: NormalizedContainer['published'] = [];
	for (const p of c.ports ?? []) {
		if (!p.publicPort || (p.type && p.type !== 'tcp')) continue;
		const host = !p.ip || p.ip === '0.0.0.0' || p.ip === '::' || /^127\./.test(p.ip) ? envHost : p.ip;
		if (!published.some((x) => x.host === host && x.port === p.publicPort)) published.push({ containerPort: p.privatePort, host, port: p.publicPort });
	}
	return {
		id: c.id,
		name: nameOf(c),
		image: c.image,
		state: stateOf(c),
		status: c.status ?? stateOf(c),
		env: envMap(c.config?.env),
		labels: c.labels ?? {},
		exposed: [...new Set([...(c.ports ?? []).map((p) => p.privatePort), ...Object.keys(c.config?.exposedPorts ?? {}).map((k) => Number(k.split('/')[0]))])],
		published,
		networks: Object.fromEntries(Object.entries(c.networkSettings?.networks ?? {}).map(([n, v]) => [n, v?.ipAddress ?? ''])),
		networkMode: c.hostConfig?.networkMode,
		devices: (c.hostConfig?.devices ?? []).map((d) => ({ host: d.pathOnHost ?? d.PathOnHost ?? '', container: d.pathInContainer ?? d.PathInContainer ?? '' })).filter((d) => d.host),
		binds,
		privileged: !!c.hostConfig?.privileged
	};
}

/** Address for ports published on an environment's Docker host. */
export function environmentHost(env: ArcaneEnvironment, managerUrl: string): string {
	const managerHost = new URL(managerUrl).hostname;
	try {
		const h = env.apiUrl ? new URL(env.apiUrl).hostname : '';
		// The local environment points at Arcane itself (often localhost); use the address we reach Arcane on.
		return !h || /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\])/.test(h) ? managerHost : h;
	} catch {
		return managerHost;
	}
}

async function scanArcane(manager: ArcaneManager, apiKey: string): Promise<ArcaneScan> {
	const client = new ArcaneClient(manager.url, apiKey);
	const scan: ArcaneScan = { manager, environments: [] };
	const environments = (await client.list<ArcaneEnvironment>('/environments')).filter((e) => e.enabled !== false);
	for (const env of environments) {
		const host = environmentHost(env, manager.url);
		const entry: ArcaneScan['environments'][number] = { id: env.id, name: env.name ?? env.id, host, candidates: [] };
		scan.environments.push(entry);
		try {
			const base = `/environments/${encodeURIComponent(env.id)}/containers`;
			const list = (await client.list<ArcaneContainer>(base)).slice(0, 500);
			entry.inspected = list.length;
			const self = findSelf(
				list.map((c) => ({
					id: c.id,
					name: nameOf(c),
					networks: Object.fromEntries(Object.entries(c.networkSettings?.networks ?? {}).map(([n, v]) => [n, v?.ipAddress ?? ''])),
					published: [],
					running: stateOf(c) === 'running'
				}))
			);
			entry.self = self;
			// Detect on the summary first; only inspect likely OctoPrint containers (env, devices).
			const likely = list.filter((c) => {
				const n = normalizeArcane(c, host);
				return detectOctoPrint(n) || /octo/i.test(c.image) || /octo/i.test(n.name);
			});
			const details = await mapLimit(likely, 6, (c) =>
				client
					.data<ArcaneContainer>(`${base}/${encodeURIComponent(c.id)}`)
					.then((d) => ({ ...c, ...d }))
					.catch(() => c)
			);
			const ref = `${manager.name} · ${entry.name}`;
			const candidates: Candidate[] = [];
			for (const c of details) {
				const n = normalizeArcane(c, host);
				const det = detectOctoPrint(n);
				if (!det || n.name === self.container) continue;
				candidates.push(await containerCandidate(n, det, { kind: 'arcane', refPrefix: ref, label: ref, self, inContainer: !!self.container, dockerHost: host }));
			}
			entry.candidates = candidates.sort((a, b) => a.name.localeCompare(b.name));
		} catch (err) {
			const message = (err as Error).message;
			entry.error = /rejected the API key|403/.test(message) ? 'The API key needs containers:list and containers:read for this environment.' : message;
		}
	}
	return scan;
}

export async function scanArcaneAll(): Promise<ArcaneScan[]> {
	return Promise.all(
		listArcane().map(async (manager) => {
			const key = arcaneKey(manager.id);
			if (!key) return { manager, error: 'No API key configured', environments: [] };
			try {
				return await scanArcane(manager, key);
			} catch (err) {
				return { manager, error: (err as Error).message, environments: [] };
			}
		})
	);
}

/** Checks a URL + key and reports how many environments it sees. */
export async function testArcane(url: string, apiKey: string): Promise<{ ok: true; environments: number } | { ok: false; error: string }> {
	try {
		return { ok: true, environments: (await new ArcaneClient(url, apiKey).list<ArcaneEnvironment>('/environments')).length };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}
