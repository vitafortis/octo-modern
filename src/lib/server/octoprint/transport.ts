/**
 * HTTP and WebSocket transports. Servers with a verified certificate (or plain http)
 * use Node's built-in fetch and WebSocket; servers with "Verify TLS" turned off use
 * undici's, with a dispatcher that accepts any certificate. (The built-in ones are
 * undici too, but only the package lets us pass our own dispatcher reliably.)
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Agent, fetch as undiciFetch, WebSocket as UndiciWebSocket } from 'undici';

let insecure: Agent | undefined;
function insecureAgent(): Agent {
	insecure ??= new Agent({ connect: { rejectUnauthorized: false } });
	return insecure;
}

export interface HttpInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array | FormData | ReadableStream<Uint8Array> | null;
	signal?: AbortSignal;
	/** Needed when streaming a request body. */
	duplex?: 'half';
}

export function httpFetch(url: string, init: HttpInit, verifyTls: boolean): Promise<Response> {
	if (verifyTls || !url.startsWith('https:')) return fetch(url, init as RequestInit);
	return undiciFetch(url, { ...(init as object), dispatcher: insecureAgent() } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

/** The parts of the WebSocket API the push client uses (also what tests fake). */
export interface SocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onclose: ((ev: { code: number; reason: string }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
}

export function openWebSocket(url: string, verifyTls: boolean): SocketLike {
	if (verifyTls || !url.startsWith('wss:')) return new WebSocket(url) as unknown as SocketLike;
	return new UndiciWebSocket(url, { dispatcher: insecureAgent() }) as unknown as SocketLike;
}

/**
 * Streams a request body (e.g. an upload) to `url` with node:http's own backpressure:
 * chunks are only read from `body` as fast as the socket takes them. Resolves with
 * the status and the (small) response text.
 */
export function streamRequest(
	url: string,
	opts: { method: string; headers: Record<string, string>; body: ReadableStream<Uint8Array>; verifyTls: boolean; signal?: AbortSignal; timeoutMs?: number }
): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
		const req = send(
			u,
			{ method: opts.method, headers: opts.headers, signal: opts.signal, timeout: opts.timeoutMs, ...(u.protocol === 'https:' && !opts.verifyTls ? { rejectUnauthorized: false } : {}) },
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (d) => (text.length < 1_000_000 ? (text += d) : undefined));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
				res.on('error', reject);
			}
		);
		req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
		req.on('error', reject);
		pipeline(Readable.fromWeb(opts.body as import('node:stream/web').ReadableStream, { highWaterMark: 64 * 1024 }), req).catch(reject);
	});
}
