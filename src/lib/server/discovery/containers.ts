/**
 * OctoPrint containers, whichever API they came from (Docker or Arcane): detection,
 * the serial devices mapped into them, and turning one into a candidate.
 */
import { urlFor, type Candidate, type SelfNetworks, type SerialDevice } from '#lib/discovery.ts';
import { networkPath } from './network.ts';
import { settle, type Address, type SettleDeps } from './settle.ts';

/** A container normalised from the Docker Engine or Arcane API. */
export interface NormalizedContainer {
	id: string;
	name: string;
	image: string;
	state: string;
	status: string;
	env: Record<string, string>;
	labels: Record<string, string>;
	/** Exposed container ports (tcp). */
	exposed: number[];
	/** Published bindings: container port → reachable host address. */
	published: { containerPort: number; host: string; port: number }[];
	/** Network name → IP ('' when unknown). */
	networks: Record<string, string>;
	networkMode?: string;
	devices: { host: string; container: string }[];
	binds: { source: string; destination: string }[];
	privileged: boolean;
}

export function envMap(env: string[] | null | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of env ?? []) {
		const i = line.indexOf('=');
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
	}
	return out;
}

/** Image path without registry and tag: `ghcr.io/linuxserver/octoprint:latest` → `linuxserver/octoprint`. */
export function imageName(image: string): { path: string; tag: string | null } {
	const noDigest = image.split('@')[0];
	const slash = noDigest.lastIndexOf('/');
	const colon = noDigest.lastIndexOf(':');
	const tag = colon > slash ? noDigest.slice(colon + 1) : null;
	let path = (colon > slash ? noDigest.slice(0, colon) : noDigest).toLowerCase();
	const parts = path.split('/');
	// A first segment with a dot or port is a registry (ghcr.io, lscr.io, registry:5000).
	if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0])) path = parts.slice(1).join('/');
	return { path, tag };
}

const NOT_OCTOPRINT = /exporter|prometheus|telegraf|grafana|obico|spaghetti|octoeverywhere|octoapp|moonraker|klipper|mainsail|fluidd/i;
const OCTO_PORTS = [80, 5000, 443];

export interface Detection {
	/** Container ports to try, in order. */
	ports: number[];
	reason: string;
	/** Version from the image tag or `octoprint_ref`, when it looks like one. */
	versionHint: string | null;
}

/**
 * Recognizes OctoPrint containers: by image (`octoprint/octoprint`, `linuxserver/octoprint`,
 * anything named …/octoprint), or a container exposing 80/5000 whose labels, environment
 * or name mention OctoPrint. Exporters and companion tools are skipped.
 */
export function detectOctoPrint(c: Pick<NormalizedContainer, 'image' | 'env' | 'labels' | 'exposed' | 'published' | 'name' | 'networkMode'>): Detection | null {
	const { path, tag } = imageName(c.image);
	if (NOT_OCTOPRINT.test(path)) return null;
	const offered = [...new Set([...c.exposed, ...c.published.map((p) => p.containerPort)])];
	const ports = OCTO_PORTS.filter((p) => offered.includes(p));
	const webPort = ports.some((p) => p === 80 || p === 5000) || c.networkMode === 'host';
	const ref = c.env.octoprint_ref ?? c.env.OCTOPRINT_VERSION;
	const versionHint = [ref, tag].find((v) => v && /^v?\d+\.\d+(\.\d+)?/.test(v))?.replace(/^v/, '').replace(/-.*$/, '') ?? null;
	const portsOrDefault = ports.length ? ports : [80, 5000];

	if (/(^|\/)octoprint(-docker)?$/.test(path) || /(^|\/)octoprint[-_]/.test(path)) return { ports: portsOrDefault, reason: `image ${path}`, versionHint };
	if (!webPort) return null;
	if (ref || Object.keys(c.env).some((k) => /^OCTOPRINT_/i.test(k))) return { ports: portsOrDefault, reason: 'OctoPrint environment variables', versionHint };
	const label = Object.entries(c.labels).find(([k, v]) => /octoprint/i.test(k) || /octoprint/i.test(v));
	if (label) return { ports: portsOrDefault, reason: `label ${label[0]}`, versionHint };
	if (/octo(print|pi)/i.test(c.name)) return { ports: portsOrDefault, reason: 'container name', versionHint };
	return null;
}

const SERIAL = /^\/dev\/(tty(USB|ACM|AMA|XRUSB|S)\d+|serial\/by-(id|path)\/.+|ttyPrinter.*|printer.*)$/;

/** Printer serial ports mapped into the container: `--device`, bind mounts, or privileged with /dev. */
export function serialDevices(c: Pick<NormalizedContainer, 'devices' | 'binds' | 'privileged'>): SerialDevice[] {
	const out: SerialDevice[] = [];
	for (const d of c.devices) if (SERIAL.test(d.host) || SERIAL.test(d.container)) out.push({ host: d.host, container: d.container || d.host, via: 'device' });
	for (const b of c.binds) {
		if (SERIAL.test(b.source) || SERIAL.test(b.destination)) out.push({ host: b.source, container: b.destination, via: 'bind' });
		else if (b.source === '/dev' && c.privileged) out.push({ host: '/dev', container: b.destination, via: 'privileged' });
	}
	if (c.privileged && !out.length) out.push({ host: '/dev/*', container: '/dev/*', via: 'privileged' });
	const seen = new Set<string>();
	return out.filter((d) => (seen.has(d.host) ? false : (seen.add(d.host), true)));
}

export interface CandidateContext {
	kind: 'docker' | 'arcane';
	/** Prefix of `source.ref` (the endpoint or "Arcane · env"). */
	refPrefix: string;
	label: string;
	self: SelfNetworks;
	/** Whether octo·modern could resolve the container's name (it runs in a container). */
	inContainer: boolean;
	/** Host that reaches this Docker host (for host networking). */
	dockerHost: string;
	settleDeps?: SettleDeps;
}

/** All addresses that might reach OctoPrint in this container, best guesses first. */
export function containerAddresses(c: NormalizedContainer, det: Detection, ctx: Pick<CandidateContext, 'inContainer' | 'dockerHost'>): Address[] {
	const out: Address[] = [];
	if (c.networkMode === 'host' || 'host' in c.networks) {
		for (const port of det.ports) out.push({ host: ctx.dockerHost, port, label: 'host network' });
		return out;
	}
	for (const port of det.ports) for (const b of c.published.filter((p) => p.containerPort === port)) out.push({ host: b.host, port: b.port, label: 'published port' });
	for (const port of det.ports) {
		// Names resolve only for peers on a shared user-defined network.
		if (ctx.inContainer) out.push({ host: c.name, port, label: 'container name' });
		for (const [net, ip] of Object.entries(c.networks)) if (ip) out.push({ host: ip, port, label: `${net} network` });
	}
	return out;
}

export async function containerCandidate(c: NormalizedContainer, det: Detection, ctx: CandidateContext): Promise<Candidate> {
	const addresses = containerAddresses(c, det, ctx);
	const running = c.state === 'running';
	const port = det.ports.find((p) => c.published.some((b) => b.containerPort === p)) ?? det.ports[0];
	const network = networkPath(
		{ id: c.id, name: c.name, networks: c.networkMode === 'host' ? { host: '' } : c.networks, published: c.published.filter((b) => b.containerPort === port).map(({ host, port }) => ({ host, port })), running },
		ctx.self,
		port
	);
	const settled = addresses.length && running ? await settle(addresses, ctx.settleDeps) : null;
	const notes: string[] = [];
	const fp = settled?.fingerprint ?? { confidence: 'none' as const, version: null, apiVersion: null, appkeys: false, loginRequired: true, signals: [] };
	const fingerprint = { ...fp, version: fp.version ?? det.versionHint, signals: [`Docker: ${det.reason}`, ...fp.signals] };
	const fallback = addresses[0] ?? { host: c.name, port, label: 'container name' };
	const project = c.labels['com.docker.compose.project'];
	const service = c.labels['com.docker.compose.service'];
	return {
		key: `${ctx.kind}:${ctx.refPrefix}#${c.name}`,
		name: c.name,
		baseUrl: settled?.baseUrl ?? urlFor(fallback.host, fallback.port),
		alternates: settled?.alternates ?? addresses.slice(1).map((a) => ({ url: urlFor(a.host, a.port), label: a.label })),
		reachable: settled?.reachable ?? false,
		insecureTls: settled?.primary.port === 443 || undefined,
		fingerprint,
		source: { kind: ctx.kind, ref: `${ctx.refPrefix}#${c.name}`, label: ctx.label },
		container: { id: c.id.slice(0, 12), name: c.name, image: c.image, state: c.state, status: c.status, project, service },
		serial: serialDevices(c),
		// A stopped container has no networks or ports to explain.
		network: running ? network : undefined,
		notes
	};
}
