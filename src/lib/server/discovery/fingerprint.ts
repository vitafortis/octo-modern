/**
 * Recognizes OctoPrint without an API key. Modern OctoPrint (1.5+) answers its API
 * with 403 until you log in, so the version is usually hidden; what still answers:
 *
 * - `GET /plugin/appkeys/probe` → 204: the bundled Application Keys plugin (OctoPrint only)
 * - `GET /` → 302 to `/login/?redirect=…&permissions=…`: OctoPrint's login redirect
 * - `GET /login/` or `/` HTML titled "OctoPrint" (older versions, or access control off)
 * - `GET /api/version` → 200 `{ "server": "1.11.8", "text": "OctoPrint 1.11.8" }` when anonymous
 *   access is allowed — the only unauthenticated source of the version besides mDNS
 * - `GET /api/version` → 403 with Flask's "You don't have the permission…" JSON: a weak hint
 */
import { httpFetch } from '../octoprint/transport.ts';
import type { Fingerprint } from '#lib/discovery.ts';

export interface RawResponse {
	status: number;
	headers?: Record<string, string>;
	body?: string;
}

export interface FingerprintInput {
	/** Moonraker's `GET /server/info` (Klipper). */
	serverInfo?: RawResponse | null;
	version?: RawResponse | null;
	appkeys?: RawResponse | null;
	root?: RawResponse | null;
	login?: RawResponse | null;
}

const VERSION_RE = /^\d+\.\d+(\.\d+)?([.\-+a-z0-9]*)?$/i;

function json(body: string | undefined): Record<string, unknown> | null {
	if (!body) return null;
	try {
		const v = JSON.parse(body);
		return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

function htmlMarkers(body: string | undefined): { octoprint: boolean; version: string | null } {
	if (!body) return { octoprint: false, version: null };
	const title = /<title>\s*([^<]*)<\/title>/i.exec(body)?.[1] ?? '';
	const octoprint = /octoprint/i.test(title) || /\/static\/img\/tentacle-/i.test(body);
	const version = /DISPLAY_VERSION\s*=\s*["']([^"']+)["']/.exec(body)?.[1] ?? /\bOctoPrint\s+v?(\d+\.\d+\.\d+[^\s<"]*)/.exec(body)?.[1] ?? null;
	return { octoprint, version: version && VERSION_RE.test(version) ? version : null };
}

/** Moonraker (Klipper) from `GET /server/info`: 200 with Klippy's state, or 401 with Moonraker's JSON error. */
function moonrakerFingerprint(r: RawResponse | null | undefined): Fingerprint | null {
	if (!r) return null;
	const j = json(r.body);
	const result = j && typeof j.result === 'object' && j.result ? (j.result as Record<string, unknown>) : null;
	if (r.status === 200 && result && ('klippy_state' in result || 'moonraker_version' in result)) {
		const v = typeof result.moonraker_version === 'string' ? result.moonraker_version.replace(/-.*$/, '') : null;
		return { confidence: 'confirmed', kind: 'moonraker', version: v, apiVersion: typeof result.api_version_string === 'string' ? result.api_version_string : null, appkeys: false, loginRequired: false, signals: [`GET /server/info → Moonraker${v ? ` ${v}` : ''} (Klipper ${String(result.klippy_state ?? '?')})`] };
	}
	if ((r.status === 401 || r.status === 403) && j && typeof j.error === 'object' && j.error && typeof (j.error as { code?: unknown }).code === 'number') {
		return { confidence: 'confirmed', kind: 'moonraker', version: null, apiVersion: null, appkeys: false, loginRequired: true, signals: [`GET /server/info → ${r.status} (Moonraker wants an API key)`] };
	}
	return null;
}

/** Pure analysis of the probe responses (what the tests exercise). */
export function analyzeFingerprint(r: FingerprintInput): Fingerprint {
	// Moonraker also emulates OctoPrint's /api/version, so it's recognized first.
	const moonraker = moonrakerFingerprint(r.serverInfo);
	if (moonraker) return moonraker;
	const signals: string[] = [];
	let strong = false;
	let weak = false;
	let version: string | null = null;
	let apiVersion: string | null = null;
	let loginRequired = true;
	let appkeys = false;

	if (r.version) {
		const v = json(r.version.body);
		if (r.version.status === 200 && v && typeof v.server === 'string' && (typeof v.api === 'string' || /octoprint/i.test(String(v.text ?? '')))) {
			strong = true;
			loginRequired = false;
			version = VERSION_RE.test(v.server) ? v.server : null;
			apiVersion = typeof v.api === 'string' ? v.api : null;
			signals.push(`GET /api/version → ${String(v.text ?? `OctoPrint ${v.server}`)}`);
		} else if ((r.version.status === 403 || r.version.status === 401) && v && typeof v.error === 'string' && /permission to access the requested resource|forbidden|api key/i.test(v.error)) {
			weak = true;
			signals.push(`GET /api/version → ${r.version.status} without a key`);
		}
	}
	if (r.appkeys?.status === 204) {
		strong = true;
		appkeys = true;
		signals.push('GET /plugin/appkeys/probe → 204 (Application Keys)');
	}
	if (r.root) {
		const loc = r.root.headers?.location ?? '';
		if (r.root.status >= 300 && r.root.status < 400 && /\/login\/?\?(.*&)?redirect=/.test(loc) && /[?&]permissions=/.test(loc)) {
			strong = true;
			signals.push('GET / → OctoPrint login redirect');
		} else if (r.root.status === 200) {
			const m = htmlMarkers(r.root.body);
			if (m.octoprint) {
				strong = true;
				signals.push('GET / → OctoPrint page');
				version ??= m.version;
			}
		}
	}
	if (r.login?.status === 200) {
		const m = htmlMarkers(r.login.body);
		if (m.octoprint) {
			strong = true;
			signals.push('GET /login/ → “OctoPrint Login”');
			version ??= m.version;
		}
	}
	const clacks = [r.version, r.appkeys, r.root].some((x) => /terry pratchett/i.test(x?.headers?.['x-clacks-overhead'] ?? ''));
	if (clacks && !strong) {
		weak = true;
		signals.push('X-Clacks-Overhead header (OctoPrint sends it)');
	}
	return { confidence: strong ? 'confirmed' : weak ? 'possible' : 'none', version, apiVersion, appkeys, loginRequired, signals };
}

async function get(url: string, timeoutMs: number, verifyTls: boolean, maxBody = 32_768): Promise<RawResponse | null> {
	try {
		const res = await httpFetch(url, { method: 'GET', headers: { accept: 'application/json, text/html;q=0.9' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' } as never, verifyTls);
		let body = '';
		if (res.body) {
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			while (body.length < maxBody) {
				const { value, done } = await reader.read();
				if (done) break;
				body += decoder.decode(value, { stream: true });
			}
			void reader.cancel().catch(() => {});
		}
		const headers: Record<string, string> = {};
		res.headers.forEach((v, k) => (headers[k] = v));
		return { status: res.status, headers, body };
	} catch {
		return null;
	}
}

/** Looks at `baseUrl` without a key. Unreachable servers come back with confidence `none`. */
export async function fingerprintUrl(baseUrl: string, { timeoutMs = 3000, verifyTls = false } = {}): Promise<Fingerprint & { answered: boolean }> {
	const base = baseUrl.replace(/\/+$/, '');
	const [version, appkeys, root, serverInfo] = await Promise.all([
		get(`${base}/api/version`, timeoutMs, verifyTls),
		get(`${base}/plugin/appkeys/probe`, timeoutMs, verifyTls),
		get(`${base}/`, timeoutMs, verifyTls),
		get(`${base}/server/info`, timeoutMs, verifyTls)
	]);
	let login: RawResponse | null = null;
	const first = analyzeFingerprint({ version, appkeys, root, serverInfo });
	if (first.confidence !== 'confirmed' && root && root.status >= 300 && root.status < 400 && /\/login\/?/.test(root.headers?.location ?? '')) {
		login = await get(`${base}/login/`, timeoutMs, verifyTls);
	}
	const fp = login ? analyzeFingerprint({ version, appkeys, root, login, serverInfo }) : first;
	return { ...fp, answered: !!(version || appkeys || root) };
}
