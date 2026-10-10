/**
 * OctoPrint containers on Docker endpoints (OCM_DOCKER_HOSTS and saved ones), through
 * the Docker Engine API. Only GET /containers/json and GET /containers/{id}/json are
 * used, so a read-only socket proxy with CONTAINERS=1 is enough.
 */
import { request } from 'node:http';
import { IN_CONTAINER } from '../config.ts';
import type { DockerScan } from '#lib/discovery.ts';
import { dockerEndpoints } from './config.ts';
import { containerCandidate, detectOctoPrint, envMap, type NormalizedContainer } from './containers.ts';
import { findSelf, type ContainerNetworks } from './network.ts';
import { mapLimit } from './probe.ts';
import type { SettleDeps } from './settle.ts';

interface ContainerSummary {
	Id: string;
	Names: string[];
	Image: string;
	State: string;
	Status: string;
	NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> | null } | null;
}

interface ContainerInspect {
	Id: string;
	Name: string;
	Config: { Env: string[] | null; Image: string; Labels: Record<string, string> | null; ExposedPorts?: Record<string, object> | null };
	HostConfig?: {
		NetworkMode?: string;
		Privileged?: boolean;
		Devices?: { PathOnHost: string; PathInContainer: string }[] | null;
		Binds?: string[] | null;
	} | null;
	Mounts?: { Type?: string; Source?: string; Destination?: string }[] | null;
	NetworkSettings: {
		Ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null;
		Networks: Record<string, { IPAddress: string }> | null;
	};
}

export function dockerGet<T>(endpoint: string, path: string, timeoutMs = 5000): Promise<T> {
	const target = endpoint.startsWith('unix://')
		? { socketPath: endpoint.slice('unix://'.length), path }
		: (() => {
				const u = new URL(endpoint.replace(/^tcp:/, 'http:'));
				return { host: u.hostname, port: Number(u.port) || 2375, path: `${u.pathname.replace(/\/+$/, '')}${path}` };
			})();
	return new Promise((resolve, reject) => {
		const req = request({ ...target, method: 'GET', timeout: timeoutMs, headers: { Host: 'docker' } }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				if ((res.statusCode ?? 500) >= 400) return reject(Object.assign(new Error(`Docker API ${res.statusCode}: ${body.slice(0, 200)}`), { status: res.statusCode }));
				try {
					resolve(JSON.parse(body));
				} catch (err) {
					reject(err);
				}
			});
		});
		req.on('timeout', () => req.destroy(Object.assign(new Error('Docker API timed out'), { code: 'ETIMEDOUT' })));
		req.on('error', reject);
		req.end();
	});
}

/** Turns socket/HTTP failures into a fix the admin can apply. */
export function explainDockerError(endpoint: string, err: unknown): string {
	const e = err as NodeJS.ErrnoException & { status?: number };
	if (e.code === 'EACCES') return `Permission denied on ${endpoint}. The container runs as a non-root user: use the read-only docker-socket-proxy (see the README), or add group_add with the socket's group id.`;
	if (e.code === 'ENOENT') return `${endpoint} doesn't exist here. Mount the Docker socket or point OCM_DOCKER_HOSTS at a socket proxy.`;
	if (e.code === 'ECONNREFUSED') return `Connection refused at ${endpoint}. Is the Docker API or socket proxy running?`;
	if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return `Can't resolve ${endpoint}. Is the socket proxy on the same Docker network as octo·modern?`;
	if (e.status === 403) return `${endpoint} refused the request (403). If it's docker-socket-proxy, set CONTAINERS=1.`;
	return e.message ?? String(err);
}

/** Host that reaches ports published on this endpoint's Docker host. */
export function publishedHost(endpoint: string, hostIp: string, inContainer = IN_CONTAINER): string {
	const wildcard = !hostIp || hostIp === '0.0.0.0' || hostIp === '::';
	const loopback = /^(127\.|::1$)/.test(hostIp);
	if (!wildcard && !loopback) return hostIp;
	if (endpoint.startsWith('unix://')) return inContainer ? 'host.docker.internal' : '127.0.0.1';
	return new URL(endpoint.replace(/^tcp:/, 'http:')).hostname;
}

function bindMounts(c: ContainerInspect): { source: string; destination: string }[] {
	const out = (c.Mounts ?? []).filter((m) => m.Type === 'bind' && m.Source && m.Destination).map((m) => ({ source: m.Source!, destination: m.Destination! }));
	for (const b of c.HostConfig?.Binds ?? []) {
		const [source, destination] = b.split(':');
		if (source && destination && !out.some((m) => m.source === source)) out.push({ source, destination });
	}
	return out;
}

export function normalizeDocker(endpoint: string, c: ContainerInspect, summary: Pick<ContainerSummary, 'State' | 'Status'>, inContainer = IN_CONTAINER): NormalizedContainer {
	const published: NormalizedContainer['published'] = [];
	for (const [key, bindings] of Object.entries(c.NetworkSettings?.Ports ?? {})) {
		const [port, proto] = key.split('/');
		if (proto !== 'tcp') continue;
		for (const b of bindings ?? []) {
			const host = publishedHost(endpoint, b.HostIp, inContainer);
			const entry = { containerPort: Number(port), host, port: Number(b.HostPort) };
			if (!published.some((p) => p.host === entry.host && p.port === entry.port)) published.push(entry);
		}
	}
	return {
		id: c.Id,
		name: c.Name.replace(/^\//, ''),
		image: c.Config.Image,
		state: summary.State,
		status: summary.Status,
		env: envMap(c.Config.Env),
		labels: c.Config.Labels ?? {},
		exposed: Object.keys(c.Config.ExposedPorts ?? {})
			.filter((k) => k.endsWith('/tcp'))
			.map((k) => Number(k.split('/')[0])),
		published,
		networks: Object.fromEntries(Object.entries(c.NetworkSettings?.Networks ?? {}).map(([n, v]) => [n, v.IPAddress ?? ''])),
		networkMode: c.HostConfig?.NetworkMode,
		devices: (c.HostConfig?.Devices ?? []).map((d) => ({ host: d.PathOnHost, container: d.PathInContainer })),
		binds: bindMounts(c),
		privileged: !!c.HostConfig?.Privileged
	};
}

const summaryNetworks = (c: ContainerSummary): ContainerNetworks => ({
	id: c.Id,
	name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
	networks: Object.fromEntries(Object.entries(c.NetworkSettings?.Networks ?? {}).map(([n, v]) => [n, v.IPAddress ?? ''])),
	published: [],
	running: c.State === 'running'
});

export async function scanDockerEndpoint(endpoint: string, deps: { inContainer?: boolean; settle?: SettleDeps } = {}): Promise<DockerScan> {
	const inContainer = deps.inContainer ?? IN_CONTAINER;
	try {
		const list = await dockerGet<ContainerSummary[]>(endpoint, '/containers/json?all=1');
		const self = findSelf(list.map(summaryNetworks), { inContainer });
		// Detection needs the full inspect (env, devices); one failing doesn't hide the rest.
		const inspected = await mapLimit(list, 8, (c) => dockerGet<ContainerInspect>(endpoint, `/containers/${encodeURIComponent(c.Id)}/json`).catch(() => null));
		const dockerHost = endpoint.startsWith('unix://') ? (inContainer ? 'host.docker.internal' : '127.0.0.1') : new URL(endpoint.replace(/^tcp:/, 'http:')).hostname;
		const found = inspected
			.map((c, i) => (c ? normalizeDocker(endpoint, c, list[i], inContainer) : null))
			.filter((c): c is NormalizedContainer => !!c && c.name !== self.container)
			.map((c) => ({ c, det: detectOctoPrint(c) }))
			.filter((x) => x.det);
		const candidates = await mapLimit(found, 6, ({ c, det }) =>
			containerCandidate(c, det!, { kind: 'docker', refPrefix: endpoint, label: endpoint, self, inContainer, dockerHost, settleDeps: deps.settle })
		);
		candidates.sort((a, b) => Number(b.container?.state === 'running') - Number(a.container?.state === 'running') || a.name.localeCompare(b.name));
		return { endpoint, self, inspected: list.length, candidates };
	} catch (err) {
		return { endpoint, error: explainDockerError(endpoint, err), candidates: [] };
	}
}

export async function scanDocker(): Promise<DockerScan[]> {
	return Promise.all(dockerEndpoints().map((e) => scanDockerEndpoint(e)));
}
