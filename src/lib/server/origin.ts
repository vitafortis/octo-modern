/**
 * The URL the browser actually used. adapter-node assumes `https` when neither
 * ORIGIN nor PROTOCOL_HEADER is set, but Node itself never terminates TLS here:
 * a request is https only when a proxy says so via X-Forwarded-Proto. Getting
 * this wrong marks cookies `Secure` on plain http (so logins silently fail on a
 * LAN IP) and builds the wrong SSO callback URL.
 */
export function publicUrl(url: URL, headers: Headers): URL {
	if (process.env.ORIGIN || process.env.PROTOCOL_HEADER) return url;
	const forwarded = headers.get('x-forwarded-proto')?.split(',')[0].trim().toLowerCase();
	const out = new URL(url);
	out.protocol = forwarded === 'https' ? 'https:' : forwarded === 'http' ? 'http:' : import.meta.env.DEV ? url.protocol : 'http:';
	return out;
}

/**
 * Whether an Origin header names the host the request came to. Hosts are compared (not
 * full origins) so it works by IP, hostname, or behind a TLS-terminating proxy without
 * configuring ORIGIN (hooks.server.ts, for every write and for /mcp).
 */
export function sameHost(origin: string, url: URL, headers: Headers): boolean {
	const allowed = [url.host, headers.get('host'), headers.get('x-forwarded-host')].filter(Boolean);
	let host = '';
	try {
		host = new URL(origin).host;
	} catch {}
	return allowed.includes(host);
}
