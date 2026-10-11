/**
 * HTTP for smart plugs: timeouts, readable errors, Basic auth, and Digest auth
 * (MD5 or SHA-256, as Shelly Gen2+ devices use) answered on the 401 challenge.
 */
import { createHash, randomBytes } from 'node:crypto';

export type Fetch = typeof fetch;

export class PlugError extends Error {
	code: string;
	hint?: string;
	status?: number;
	constructor(message: string, opts: { code?: string; hint?: string; status?: number } = {}) {
		super(message);
		this.name = 'PlugError';
		this.code = opts.code ?? 'PLUG_ERROR';
		this.hint = opts.hint;
		this.status = opts.status;
	}
}

export interface PlugRequest {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	/** Basic auth sent up front, or Digest answered to a 401 challenge. */
	auth?: { username: string; password: string; scheme?: 'basic' | 'digest' };
}

export interface PlugResponse {
	status: number;
	text: string;
	json<T = unknown>(): T;
}

export interface HttpDeps {
	fetch?: Fetch;
	timeoutMs?: number;
}

/** `Digest realm="x", nonce="y", qop="auth"` → `{ realm: 'x', nonce: 'y', qop: 'auth' }`. */
export function parseChallenge(header: string): Record<string, string> | null {
	const m = /^\s*Digest\s+(.*)$/i.exec(header);
	if (!m) return null;
	const out: Record<string, string> = {};
	const re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi;
	let x: RegExpExecArray | null;
	while ((x = re.exec(m[1]))) out[x[1].toLowerCase()] = x[2] !== undefined ? x[2].replace(/\\(.)/g, '$1') : x[3];
	return out;
}

/** The Authorization header answering a Digest challenge (RFC 7616; qop=auth or none). */
export function digestAuthorization(opts: {
	method: string;
	uri: string;
	username: string;
	password: string;
	challenge: Record<string, string>;
	cnonce?: string;
	nc?: number;
}): string {
	const { challenge: c } = opts;
	const algorithm = (c.algorithm ?? 'MD5').toUpperCase();
	const alg = algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
	const H = (s: string) => createHash(alg).update(s).digest('hex');
	const nc = (opts.nc ?? 1).toString(16).padStart(8, '0');
	const cnonce = opts.cnonce ?? randomBytes(8).toString('hex');
	const qop = (c.qop ?? '')
		.split(',')
		.map((q) => q.trim())
		.includes('auth')
		? 'auth'
		: null;
	const ha1 = H(`${opts.username}:${c.realm ?? ''}:${opts.password}`);
	const ha2 = H(`${opts.method}:${opts.uri}`);
	const response = qop ? H(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${c.nonce}:${ha2}`);
	const q = (s: string) => s.replace(/(["\\])/g, '\\$1');
	const parts = [
		`username="${q(opts.username)}"`,
		`realm="${q(c.realm ?? '')}"`,
		`nonce="${q(c.nonce ?? '')}"`,
		`uri="${q(opts.uri)}"`,
		`algorithm=${algorithm}`,
		`response="${response}"`
	];
	if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
	if (c.opaque !== undefined) parts.push(`opaque="${q(c.opaque)}"`);
	return `Digest ${parts.join(', ')}`;
}

function networkError(err: unknown, host: string): PlugError {
	const e = err as { name?: string; cause?: { code?: string; message?: string }; message?: string };
	if (e.name === 'TimeoutError' || e.name === 'AbortError') {
		return new PlugError(`${host} didn’t answer in time`, { code: 'TIMEOUT', hint: 'Is the plug on the network and the address right?' });
	}
	const code = e.cause?.code ?? '';
	if (code === 'ECONNREFUSED') return new PlugError(`${host} refused the connection`, { code, hint: 'Check the address and port.' });
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new PlugError(`Can’t resolve ${host}`, { code, hint: 'Check the host name.' });
	if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new PlugError(`${host} is unreachable`, { code });
	return new PlugError(`Can’t reach ${host}: ${e.cause?.message ?? e.message ?? String(err)}`, { code: code || 'NETWORK' });
}

/** One request to a plug; non-2xx answers throw a PlugError (401/403 with an auth hint). */
export async function plugFetch(url: string, req: PlugRequest = {}, deps: HttpDeps = {}): Promise<PlugResponse> {
	const doFetch = deps.fetch ?? fetch;
	const method = req.method ?? 'GET';
	const u = new URL(url);
	const host = u.host;
	const send = async (authorization?: string) => {
		const headers: Record<string, string> = { accept: 'application/json, text/plain, */*', ...req.headers };
		if (authorization) headers.authorization = authorization;
		const once = () => doFetch(url, { method, headers, body: req.body, signal: AbortSignal.timeout(deps.timeoutMs ?? 8_000), redirect: 'manual' });
		try {
			return await once();
		} catch (err) {
			// A kept-alive connection the device closed meanwhile (it rebooted, say): one fresh try.
			const code = (err as { cause?: { code?: string } }).cause?.code;
			if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
				try {
					return await once();
				} catch (err2) {
					throw networkError(err2, host);
				}
			}
			throw networkError(err, host);
		}
	};
	const a = req.auth;
	let res = await send(a && a.scheme !== 'digest' ? `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}` : undefined);
	if (res.status === 401 && a) {
		const challenge = parseChallenge(res.headers.get('www-authenticate') ?? '');
		if (challenge) {
			await res.arrayBuffer().catch(() => {});
			res = await send(digestAuthorization({ method, uri: u.pathname + u.search, username: a.username, password: a.password, challenge }));
		}
	}
	const text = await res.text().catch(() => '');
	if (res.status === 401 || res.status === 403) {
		throw new PlugError(`${host} rejected the credentials (HTTP ${res.status})`, {
			code: 'AUTH',
			status: res.status,
			hint: a ? 'Check the username and password (or token).' : 'The device asks for a login: add the username and password (or token).'
		});
	}
	if (res.status < 200 || res.status >= 300) {
		const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
		throw new PlugError(`${host} answered HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, { code: 'HTTP', status: res.status });
	}
	return {
		status: res.status,
		text,
		json<T>() {
			try {
				return JSON.parse(text) as T;
			} catch {
				throw new PlugError(`${host} sent something that isn’t JSON`, { code: 'BAD_RESPONSE', hint: 'Is the address pointing at the plug itself?' });
			}
		}
	};
}
