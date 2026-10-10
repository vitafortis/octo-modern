import type { ProblemInfo } from '#lib/types.ts';

/**
 * An error talking to OctoPrint, with the HTTP status (when there was a response),
 * a short code and a hint for the person fixing it.
 */
export class OctoPrintError extends Error {
	status?: number;
	code?: string;
	hint?: string;

	constructor(message: string, opts: { status?: number; code?: string; hint?: string; cause?: unknown } = {}) {
		super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
		this.name = 'OctoPrintError';
		this.status = opts.status;
		this.code = opts.code;
		this.hint = opts.hint;
	}

	toJSON(): ProblemInfo {
		return { message: this.message, code: this.code, hint: this.hint, status: this.status };
	}
}

const DOCKER_LOCALHOST =
	'Inside Docker, "localhost" is octo·modern’s own container: use the OctoPrint host’s IP or name (or host.docker.internal for a server on the Docker host).';

/** Network and TLS failures, by Node error code. */
export const NETWORK_HINTS: Record<string, { message: string; hint: string }> = {
	ECONNREFUSED: { message: 'Connection refused', hint: `Is OctoPrint running, and is the port right? ${DOCKER_LOCALHOST}` },
	ENOTFOUND: { message: 'Host not found', hint: 'Check the hostname. Names like octopi.local need mDNS, which usually doesn’t work inside containers; use the IP address.' },
	EAI_AGAIN: { message: 'Could not resolve the hostname', hint: 'DNS lookup failed temporarily. Check the name, or use the IP address.' },
	ETIMEDOUT: { message: 'Timed out', hint: 'The server didn’t answer in time. Is it on, and reachable from the machine running octo·modern?' },
	TIMEOUT: { message: 'Timed out', hint: 'OctoPrint didn’t answer in time. It may be busy (e.g. a slow Raspberry Pi during a print) or unreachable.' },
	EHOSTUNREACH: { message: 'Host unreachable', hint: 'No route to that address. Check the IP and that both machines are on the same network.' },
	ENETUNREACH: { message: 'Network unreachable', hint: 'No route to that network from octo·modern.' },
	ECONNRESET: { message: 'Connection reset', hint: 'The server closed the connection. If OctoPrint is behind a reverse proxy, check the proxy, and whether the URL needs https.' },
	EPIPE: { message: 'Connection closed', hint: 'The server closed the connection unexpectedly.' },
	UND_ERR_SOCKET: { message: 'Connection closed', hint: 'The server closed the connection unexpectedly. If it uses https, make sure the URL does too.' },
	DEPTH_ZERO_SELF_SIGNED_CERT: { message: 'Self-signed TLS certificate', hint: 'Turn off “Verify TLS certificate” for this server, or use plain http on your LAN.' },
	SELF_SIGNED_CERT_IN_CHAIN: { message: 'Self-signed certificate in chain', hint: 'Turn off “Verify TLS certificate” for this server.' },
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: { message: 'Unverifiable TLS certificate', hint: 'The certificate chain is incomplete or private. Turn off “Verify TLS certificate” for this server.' },
	UNABLE_TO_GET_ISSUER_CERT_LOCALLY: { message: 'Unknown certificate authority', hint: 'Turn off “Verify TLS certificate” for this server, or add the CA to NODE_EXTRA_CA_CERTS.' },
	CERT_HAS_EXPIRED: { message: 'TLS certificate expired', hint: 'Renew the certificate, or turn off “Verify TLS certificate” for this server.' },
	ERR_TLS_CERT_ALTNAME_INVALID: { message: 'Certificate doesn’t match the hostname', hint: 'Use the hostname the certificate was issued for, or turn off “Verify TLS certificate”.' },
	ERR_SSL_WRONG_VERSION_NUMBER: { message: 'Not an https server', hint: 'The server speaks plain http on that port: change the URL to http://.' },
	EPROTO: { message: 'TLS handshake failed', hint: 'The server may not speak https on that port: try http://.' }
};

/** HTTP statuses OctoPrint answers with, and what they usually mean. */
export function httpHint(status: number, path = ''): string | undefined {
	if (status === 401 || status === 403) {
		return path.includes('/api/') && !path.startsWith('/api/currentuser')
			? 'OctoPrint refused the API key, or the key’s user lacks the permission for this. Create an Application Key (OctoPrint → Settings → Application Keys) or copy a user’s API key (User Settings → API key).'
			: 'OctoPrint refused the API key.';
	}
	if (status === 404) return 'Not found. Check the base URL; behind a reverse proxy, include its path (e.g. https://host/octoprint).';
	if (status === 409) return 'The printer isn’t in a state that allows this (not connected, or busy printing).';
	if (status === 413) return 'The file is too large for the server (or a reverse proxy in front of it).';
	if (status === 415) return 'OctoPrint doesn’t accept that file type.';
	if (status === 502 || status === 503 || status === 504) return 'A proxy in front of OctoPrint couldn’t reach it, or OctoPrint is still starting.';
	if (status >= 500) return 'OctoPrint hit an internal error; its log (octoprint.log) has the details.';
	return undefined;
}

/** The innermost Node error code in an error's cause chain (fetch wraps the real one). */
export function errorCode(err: unknown): string | undefined {
	let e = err as { code?: unknown; cause?: unknown; name?: unknown } | undefined;
	let code: string | undefined;
	for (let depth = 0; e && depth < 6; depth++) {
		if (typeof e.code === 'string' && /^[A-Z_0-9]+$/.test(e.code)) code = e.code;
		if (e.name === 'TimeoutError' || e.name === 'AbortError') code ??= 'TIMEOUT';
		e = e.cause as typeof e;
	}
	return code;
}

/** Turns anything thrown while talking to OctoPrint into an OctoPrintError with a hint. */
export function toOctoPrintError(err: unknown, host?: string): OctoPrintError {
	if (err instanceof OctoPrintError) return err;
	const code = errorCode(err);
	const known = code ? NETWORK_HINTS[code] : undefined;
	if (known) return new OctoPrintError(host ? `${known.message} (${host})` : known.message, { code, hint: known.hint, cause: err });
	const message = err instanceof Error ? err.message : String(err);
	return new OctoPrintError(message === 'fetch failed' ? `Could not reach ${host ?? 'OctoPrint'}` : message, { code, cause: err });
}

/** Builds the error for a non-2xx response, preferring OctoPrint's own `error` text. */
export function httpError(status: number, path: string, body: string): OctoPrintError {
	let detail = '';
	try {
		const j = JSON.parse(body) as { error?: unknown; message?: unknown };
		detail = typeof j.error === 'string' ? j.error : typeof j.message === 'string' ? j.message : '';
	} catch {
		// HTML error pages (proxies) or plain text: keep a short, tag-free excerpt.
		detail = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
	}
	const base =
		status === 401 || status === 403
			? 'API key rejected'
			: status === 404
				? 'Not found'
				: status === 409
					? 'Printer not ready'
					: `OctoPrint answered HTTP ${status}`;
	// OctoPrint's generic 403 text ("…read-protected or not readable…") says nothing useful.
	const useful = detail && !/read-protected|not readable by the server/i.test(detail);
	return new OctoPrintError(useful ? `${base}: ${detail}` : base, { status, code: `HTTP_${status}`, hint: httpHint(status, path) });
}
