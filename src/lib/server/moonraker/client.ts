/**
 * A small REST client for one Moonraker server (Klipper's API server, what Mainsail
 * and Fluidd talk to). The API key is optional: Moonraker trusts clients on networks
 * listed in its `[authorization] trusted_clients`, and wants `X-Api-Key` otherwise.
 * Answers come wrapped as `{ result }`, errors as `{ error: { code, message } }`.
 */
import { OctoPrintError, toOctoPrintError } from '../octoprint/errors.ts';
import { httpFetch, type HttpInit } from '../octoprint/transport.ts';

export interface MoonrakerTarget {
	baseUrl: string;
	/** Empty when Moonraker trusts octo·modern's address. */
	apiKey: string;
	verifyTls: boolean;
}

export interface MoonrakerRequest {
	json?: unknown;
	body?: HttpInit['body'];
	headers?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Statuses that resolve (as the raw response) instead of throwing. */
	allow?: number[];
}

/** Moonraker's JSON-RPC websocket endpoint for a base URL. */
export function websocketUrl(baseUrl: string, token?: string | null): string {
	return `${baseUrl.replace(/^http/i, 'ws')}/websocket${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** Encodes each segment of a path (keeps the slashes). */
export function encodeSegments(path: string): string {
	return path
		.split('/')
		.filter(Boolean)
		.map((s) => encodeURIComponent(s))
		.join('/');
}

/** A hint for Moonraker's HTTP statuses. */
export function moonrakerHint(status: number): string | undefined {
	if (status === 401 || status === 403)
		return 'Moonraker wants an API key: copy it from Mainsail/Fluidd (Settings → Authorization / API key), or add octo·modern’s address to trusted_clients in moonraker.conf.';
	if (status === 404) return 'Not found. Check the URL: Moonraker usually listens on port 7125 (or behind Mainsail/Fluidd’s web server on 80).';
	if (status === 503) return 'Klipper isn’t ready (it may be starting, shut down, or not connected to its MCU). A firmware restart usually helps.';
	if (status >= 500) return 'Moonraker reported an error; moonraker.log and klippy.log have the details.';
	return undefined;
}

/** The error for a non-2xx answer, preferring Moonraker's own message. */
export function moonrakerError(status: number, text: string): OctoPrintError {
	let detail = '';
	try {
		const j = JSON.parse(text) as { error?: { message?: unknown } | string };
		detail = typeof j.error === 'string' ? j.error : typeof j.error?.message === 'string' ? j.error.message : '';
	} catch {
		detail = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
	}
	const base = status === 401 || status === 403 ? 'Moonraker refused the request (API key)' : status === 404 ? 'Not found' : `Moonraker answered HTTP ${status}`;
	const code = status === 400 && /klippy|not ready|shutdown/i.test(detail) ? 'KLIPPY' : `HTTP_${status}`;
	return new OctoPrintError(detail ? `${base}: ${detail}` : base, { status: status === 400 && /print.*(in progress|already)|busy/i.test(detail) ? 409 : status, code, hint: moonrakerHint(status) });
}

export class MoonrakerClient {
	readonly target: MoonrakerTarget;
	readonly timeoutMs: number;

	constructor(target: MoonrakerTarget, timeoutMs = 10_000) {
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

	headers(extra?: Record<string, string>): Record<string, string> {
		return { ...(this.target.apiKey ? { 'X-Api-Key': this.target.apiKey } : {}), accept: 'application/json', ...extra };
	}

	async request(method: string, path: string, opts: MoonrakerRequest = {}): Promise<Response> {
		const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
		const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
		const headers = this.headers(opts.headers);
		let body = opts.body;
		if (opts.json !== undefined) {
			headers['content-type'] = 'application/json';
			body = JSON.stringify(opts.json);
		}
		let res: Response;
		try {
			res = await httpFetch(this.url(path), { method, headers, body, signal, duplex: body instanceof ReadableStream ? 'half' : undefined }, this.target.verifyTls);
		} catch (err) {
			if (timeout.aborted && !opts.signal?.aborted) throw toOctoPrintError(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }), this.host);
			throw toOctoPrintError(err, this.host);
		}
		if (!res.ok && !opts.allow?.includes(res.status)) {
			const text = await res.text().catch(() => '');
			throw moonrakerError(res.status, text);
		}
		return res;
	}

	/** The `result` of a JSON answer. */
	async call<T>(method: string, path: string, opts: MoonrakerRequest = {}): Promise<T> {
		const res = await this.request(method, path, opts);
		const text = await res.text();
		if (!text) return undefined as T;
		let j: unknown;
		try {
			j = JSON.parse(text);
		} catch {
			throw new OctoPrintError('Moonraker sent something that isn’t JSON', {
				code: 'BAD_RESPONSE',
				hint: 'Is the URL pointing at Moonraker (port 7125, or the Mainsail/Fluidd host)?',
				status: res.status
			});
		}
		return (j && typeof j === 'object' && 'result' in j ? (j as { result: unknown }).result : j) as T;
	}

	get<T>(path: string, opts?: MoonrakerRequest) {
		return this.call<T>('GET', path, opts);
	}

	post<T>(path: string, json?: unknown, opts?: MoonrakerRequest) {
		return this.call<T>('POST', path, json === undefined ? opts : { ...opts, json });
	}

	// --- endpoints -----------------------------------------------------------------

	serverInfo() {
		return this.get<Record<string, unknown>>('/server/info');
	}

	printerInfo() {
		return this.get<Record<string, unknown>>('/printer/info');
	}

	objectList() {
		return this.get<{ objects?: string[] }>('/printer/objects/list');
	}

	/** Current values of the given objects (`null` = every field). */
	query(objects: Record<string, string[] | null>) {
		return this.post<{ eventtime?: number; status?: Record<string, Record<string, unknown>> }>('/printer/objects/query', { objects });
	}

	/** A one-shot token for the websocket (only needed with an API key). */
	oneshotToken() {
		return this.get<string>('/access/oneshot_token');
	}

	/**
	 * Runs G-code (several lines in one script). Klipper answers when the script has run,
	 * which can take long (G28, heating); the request keeps going in the background after
	 * `waitMs`, and errors that come later are only logged.
	 */
	async gcode(script: string, waitMs = 4_000): Promise<void> {
		const req = this.post<unknown>('/printer/gcode/script', { script }, { timeoutMs: 15 * 60_000 });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), waitMs)));
		try {
			const r = await Promise.race([req.then(() => 'done' as const), late]);
			if (r === 'late') req.catch((err) => console.warn(`[octo-modern] Klipper G-code “${script.slice(0, 60)}” failed: ${(err as Error).message}`));
		} finally {
			clearTimeout(timer);
		}
	}
}

/** A client for a stored Klipper printer (the key may be empty). */
export function moonrakerFor(printer: { baseUrl: string; verifyTls: boolean }, apiKey: string, timeoutMs?: number): MoonrakerClient {
	return new MoonrakerClient({ baseUrl: printer.baseUrl, apiKey, verifyTls: printer.verifyTls }, timeoutMs);
}
