/**
 * A small REST client for one OctoPrint server. Every request carries the API key
 * (X-Api-Key) and a timeout; failures become OctoPrintErrors with a hint. The browser
 * never talks to OctoPrint: routes call this, so keys stay on the server.
 */
import { httpError, OctoPrintError, toOctoPrintError } from './errors.ts';
import { httpFetch, type HttpInit } from './transport.ts';

export interface OctoTarget {
	baseUrl: string;
	apiKey: string;
	verifyTls: boolean;
}

export interface RequestOptions {
	/** JSON body (sets the content type). */
	json?: unknown;
	body?: HttpInit['body'];
	headers?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Statuses that resolve (as the raw response) instead of throwing. */
	allow?: number[];
}

export interface VersionInfo {
	api: string;
	server: string;
	text: string;
}

export interface CurrentUser {
	name: string | null;
	permissions: string[];
	groups: string[];
}

export interface ConnectionInfo {
	current: { state: string; port: string | null; baudrate: number | null; printerProfile: string | null };
	options: {
		ports: string[];
		baudrates: number[];
		printerProfiles: { id: string; name: string }[];
		portPreference: string | null;
		baudratePreference: number | null;
		printerProfilePreference: string | null;
		autoconnect?: boolean;
	};
}

/**
 * Normalizes what people paste: adds http:// when there's no scheme, drops a trailing
 * slash, query and fragment, and keeps a path prefix (OctoPrint behind a proxy at /octoprint).
 */
export function normalizeBaseUrl(raw: string): string {
	let s = raw.trim();
	if (!s) throw new Error('Enter the OctoPrint URL');
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		throw new Error(`“${raw}” is not a valid URL`);
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The URL must start with http:// or https://');
	if (u.username || u.password) throw new Error('Leave credentials out of the URL; use the API key field');
	const path = u.pathname.replace(/\/+$/, '');
	return `${u.protocol}//${u.host}${path}`;
}

/** OctoPrint's raw SockJS websocket endpoint for a base URL. */
export function pushUrl(baseUrl: string): string {
	return `${baseUrl.replace(/^http/i, 'ws')}/sockjs/websocket`;
}

export class OctoPrintClient {
	readonly target: OctoTarget;
	readonly timeoutMs: number;

	constructor(target: OctoTarget, timeoutMs = 10_000) {
		this.target = target;
		this.timeoutMs = timeoutMs;
	}

	get host(): string {
		try {
			return new URL(this.target.baseUrl).host;
		} catch {
			return this.target.baseUrl;
		}
	}

	url(path: string): string {
		return `${this.target.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
	}

	/** Sends a request and returns the raw response; non-2xx statuses throw unless allowed. */
	async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
		const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
		const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
		const headers: Record<string, string> = { 'X-Api-Key': this.target.apiKey, accept: 'application/json', ...opts.headers };
		let body = opts.body;
		if (opts.json !== undefined) {
			headers['content-type'] = 'application/json';
			body = JSON.stringify(opts.json);
		}
		let res: Response;
		try {
			res = await httpFetch(
				this.url(path),
				{ method, headers, body, signal, duplex: body instanceof ReadableStream ? 'half' : undefined },
				this.target.verifyTls
			);
		} catch (err) {
			if (timeout.aborted && !opts.signal?.aborted) {
				throw toOctoPrintError(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }), this.host);
			}
			throw toOctoPrintError(err, this.host);
		}
		if (!res.ok && !opts.allow?.includes(res.status)) {
			const text = await res.text().catch(() => '');
			throw httpError(res.status, path, text);
		}
		return res;
	}

	async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
		const res = await this.request(method, path, opts);
		if (res.status === 204) return undefined as T;
		const text = await res.text();
		if (!text) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new OctoPrintError('OctoPrint sent something that isn’t JSON', {
				code: 'BAD_RESPONSE',
				hint: 'Is the URL pointing at OctoPrint itself (not a login page or another app on the same host)?',
				status: res.status
			});
		}
	}

	get<T>(path: string, opts?: RequestOptions) {
		return this.json<T>('GET', path, opts);
	}

	post<T>(path: string, json: unknown, opts?: RequestOptions) {
		return this.json<T>('POST', path, { ...opts, json });
	}

	// --- endpoints -----------------------------------------------------------------

	version() {
		return this.get<VersionInfo>('/api/version');
	}

	async currentUser(): Promise<CurrentUser> {
		const u = await this.get<{ name?: string | null; permissions?: unknown[]; groups?: unknown[] }>('/api/currentuser');
		const names = (list: unknown[] | undefined) =>
			(list ?? []).map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && 'key' in p ? String((p as { key: unknown }).key) : '')).filter(Boolean);
		return { name: u?.name ?? null, permissions: names(u?.permissions), groups: names(u?.groups) };
	}

	/** A passive login with the API key: the session the push socket authenticates with. */
	async passiveLogin(): Promise<{ name: string; session: string }> {
		const r = await this.post<{ name?: string; session?: string }>('/api/login', { passive: true });
		if (!r?.name || !r.session) {
			throw new OctoPrintError('OctoPrint didn’t open a session for this API key', {
				code: 'NO_SESSION',
				hint: 'The key may be invalid or belong to a deactivated user.'
			});
		}
		return { name: r.name, session: r.session };
	}

	connection() {
		return this.get<ConnectionInfo>('/api/connection');
	}

	connect(opts: { port?: string; baudrate?: number; printerProfile?: string; save?: boolean; autoconnect?: boolean }) {
		const body: Record<string, unknown> = { command: 'connect' };
		for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '' && v !== null) body[k] = v;
		return this.post<void>('/api/connection', body);
	}

	disconnect() {
		return this.post<void>('/api/connection', { command: 'disconnect' });
	}

	/** /api/printer, or null while no printer is connected (OctoPrint answers 409). */
	async printer(): Promise<unknown | null> {
		const res = await this.request('GET', '/api/printer?history=false&exclude=sd', { allow: [409] });
		if (res.status === 409) return null;
		return res.json();
	}

	job() {
		return this.get<unknown>('/api/job');
	}

	settings() {
		return this.get<Record<string, unknown>>('/api/settings');
	}

	/** start | cancel | restart | pause (with action pause/resume/toggle). */
	jobCommand(command: 'start' | 'cancel' | 'restart' | 'pause', action?: 'pause' | 'resume' | 'toggle') {
		return this.post<void>('/api/job', action ? { command, action } : { command });
	}

	/** Sets a heater's target: `tool0`…, `bed` or `chamber`. 0 turns it off. */
	setTarget(heater: string, value: number) {
		if (heater === 'bed') return this.post<void>('/api/printer/bed', { command: 'target', target: value });
		if (heater === 'chamber') return this.post<void>('/api/printer/chamber', { command: 'target', target: value });
		return this.post<void>('/api/printer/tool', { command: 'target', targets: { [heater]: value } });
	}

	/** Sends G-code lines to the printer. */
	sendCommands(commands: string[]) {
		return this.post<void>('/api/printer/command', { commands });
	}
}
