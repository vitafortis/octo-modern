/**
 * API tokens: read-only status tokens for dashboards (Homepage, Glance, Uptime Kuma,
 * Home Assistant), slicer upload keys (scope `upload`, see octoprint-compat.ts), and
 * MCP tokens for AI assistants (scope `mcp`, see mcp/).
 *
 * A token is `ocm_` (MCP: `ocx_`) + 32 random bytes (base64url), shown once; only its
 * SHA-256 is stored. Tokens are never sessions: hooks.server.ts accepts status tokens on
 * the status routes (`STATUS_ROUTE`, GET only; plus POST /api/status/<id>/bed-clear when
 * the token allows it), upload keys under /octoprint/api/ only, and MCP tokens on /mcp only.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sha256 } from './crypto.ts';
import { BadRequest } from './http.ts';
import { sqlite } from './store.ts';
import { parseTags, type UploadTarget } from '#lib/queue.ts';
import { cleanRelPath } from '#lib/library.ts';
import type { User } from '#lib/types.ts';

export const TOKEN_PREFIX = 'ocm_';
/** MCP tokens look different, so a leaked one is recognisable (and never mistaken for a status token). */
export const MCP_TOKEN_PREFIX = 'ocx_';

export type TokenScope = 'status' | 'upload' | 'mcp';
export const TOKEN_SCOPES: TokenScope[] = ['status', 'upload', 'mcp'];

/** What an MCP token may do. It never exceeds what its creator may do at the time of each call. */
export interface McpTokenOptions {
	/** `read`: status, files, history…; `control`: also pause, cancel, start, heat (operators and admins only). */
	access: 'read' | 'control';
	/** Every printer the creator can see, or only these. */
	printers: 'all' | string[];
}

export interface TokenOptions {
	/** Upload keys: where uploaded files go. */
	upload?: UploadTarget;
	/** Status tokens: may also confirm a printer's bed is clear (POST /api/status/<id>/bed-clear). */
	bedClear?: boolean;
	/** MCP tokens: access level and printers. */
	mcp?: McpTokenOptions;
}

export interface ApiToken {
	id: string;
	name: string;
	/** First characters, to tell tokens apart in the list (`ocm_AbCd…`). */
	prefix: string;
	scope: TokenScope;
	includeAddresses: boolean;
	options: TokenOptions;
	expiresAt: string | null;
	createdBy: string | null;
	/** User id of the creator (not sent to the browser). */
	createdById?: string | null;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
}

/** What a route sees after a token authenticated (event.locals.apiToken). */
export interface TokenPrincipal {
	id: string;
	name: string;
	scope: TokenScope;
	includeAddresses: boolean;
	options: TokenOptions;
	/** The user who created it (MCP tokens act as them). */
	createdById: string | null;
}

/** The only paths a token opens: GET /api/status, /api/status/<id>, /api/status/badge/<id>.svg. */
export const STATUS_ROUTE = /^\/api\/status(?:\/badge\/[^/]+\.svg|\/[^/]+)?\/?$/;

export function isStatusRoute(path: string): boolean {
	return STATUS_ROUTE.test(path);
}

/** Whether a token may be used for this request at all. */
export function tokenAllowed(method: string, path: string): boolean {
	return (method === 'GET' || method === 'HEAD') && isStatusRoute(path);
}

/** POST /api/status/<printer id>/bed-clear: status tokens with `bedClear` only. */
export const BED_CLEAR_ROUTE = /^\/api\/status\/([^/]+)\/bed-clear\/?$/;

/**
 * A new token. `alnum` avoids `-` and `_` in the random part, for slicers whose API key
 * field only takes letters and digits (they may also leave out the `ocm_` prefix).
 */
export function generateToken(alnum = false, prefix = TOKEN_PREFIX): string {
	for (;;) {
		const t = randomBytes(32).toString('base64url');
		if (!alnum || /^[A-Za-z0-9]+$/.test(t)) return prefix + t;
	}
}

const prefixFor = (scope: TokenScope) => (scope === 'mcp' ? MCP_TOKEN_PREFIX : TOKEN_PREFIX);

export const hashToken = (token: string) => sha256(token);

/** Constant-time check of a presented token against a stored hash. */
export function tokenMatches(token: string, storedHash: string): boolean {
	const a = Buffer.from(hashToken(token), 'hex');
	const b = Buffer.from(storedHash, 'hex');
	return a.length === b.length && timingSafeEqual(a, b);
}

/** A token from `Authorization: Bearer …`, or `?token=` for widgets that can't set headers. */
export function presentedToken(headers: Headers, url: URL): string | null {
	const auth = headers.get('authorization');
	const m = auth ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
	if (m) return m[1];
	return url.searchParams.get('token') || null;
}

/** Well-formed tokens only, so junk never reaches the database. */
export function looksLikeToken(token: string): boolean {
	const prefix = token.startsWith(MCP_TOKEN_PREFIX) ? MCP_TOKEN_PREFIX : TOKEN_PREFIX;
	return token.startsWith(prefix) && /^[A-Za-z0-9_-]{40,60}$/.test(token.slice(prefix.length));
}

type Row = Record<string, unknown>;

function parseOptions(raw: unknown): TokenOptions {
	if (typeof raw !== 'string' || !raw) return {};
	try {
		const o = JSON.parse(raw) as TokenOptions;
		return o && typeof o === 'object' ? o : {};
	} catch {
		return {};
	}
}

function toToken(r: Row): ApiToken {
	return {
		id: r.id as string,
		name: r.name as string,
		prefix: r.prefix as string,
		scope: r.scope as TokenScope,
		includeAddresses: r.include_addresses === 1,
		options: parseOptions(r.options),
		expiresAt: (r.expires_at as string) ?? null,
		createdBy: (r.created_by_email as string) ?? null,
		createdById: (r.created_by as string) ?? null,
		createdAt: r.created_at as string,
		lastUsedAt: (r.last_used_at as string) ?? null,
		revokedAt: (r.revoked_at as string) ?? null
	};
}

export function listTokens(): ApiToken[] {
	return (sqlite().prepare('SELECT * FROM api_tokens ORDER BY revoked_at IS NOT NULL, created_at DESC').all() as Row[]).map(toToken);
}

/** For the browser: everything but the creator's user id. */
export function publicToken(t: ApiToken): ApiToken {
	const { createdById: _c, ...rest } = t;
	return rest;
}

export function getToken(id: string): ApiToken | undefined {
	const r = sqlite().prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as Row | undefined;
	return r && toToken(r);
}

export interface TokenInput {
	name: string;
	expiresAt: string | null;
	includeAddresses: boolean;
	scope?: TokenScope;
	options?: TokenOptions;
}

/** The shape of an upload key's destination (whether the source/printer exists is checked by the route). */
export function parseUploadTarget(raw: unknown): UploadTarget {
	if (!raw || typeof raw !== 'object') throw new BadRequest('Choose where uploads go');
	const o = raw as Record<string, unknown>;
	const id = (v: unknown, what: string) => {
		if (typeof v !== 'string' || !v) throw new BadRequest(`Choose a ${what}`);
		return v;
	};
	switch (o.kind) {
		case 'library': {
			let folder: string;
			try {
				folder = cleanRelPath(typeof o.folder === 'string' ? o.folder : '');
			} catch (err) {
				throw new BadRequest(`Folder: ${(err as Error).message}`);
			}
			return { kind: 'library', sourceId: id(o.sourceId, 'library source'), folder };
		}
		case 'queue': {
			const printerId = typeof o.printerId === 'string' && o.printerId ? o.printerId : null;
			return { kind: 'queue', printerId, tags: printerId ? [] : parseTags(o.tags) };
		}
		case 'printer':
			return { kind: 'printer', printerId: id(o.printerId, 'printer'), allowPrint: o.allowPrint === true };
		default:
			throw new BadRequest('Uploads go to the library, the queue or a printer');
	}
}

/** An MCP token's `access` and `printers` (whether the printers exist is checked by the route). */
export function parseMcpOptions(b: Record<string, unknown>): McpTokenOptions {
	const access = b.access === 'control' ? 'control' : b.access === 'read' || b.access === undefined ? 'read' : null;
	if (!access) throw new BadRequest('"access" must be "read" or "control"');
	let printers: McpTokenOptions['printers'] = 'all';
	if (Array.isArray(b.printers)) {
		const ids = [...new Set(b.printers.filter((x): x is string => typeof x === 'string' && !!x))];
		if (!ids.length) throw new BadRequest('Choose at least one printer, or all printers');
		if (ids.length > 500) throw new BadRequest('Too many printers');
		printers = ids;
	} else if (b.printers !== undefined && b.printers !== 'all') throw new BadRequest('"printers" must be "all" or a list of printer ids');
	return { access, printers };
}

export function parseTokenInput(body: unknown, now = Date.now()): TokenInput {
	if (!body || typeof body !== 'object') throw new BadRequest('Expected a JSON object');
	const b = body as Record<string, unknown>;
	const name = typeof b.name === 'string' ? b.name.trim() : '';
	if (!name) throw new BadRequest('"name" is required');
	if (name.length > 80) throw new BadRequest('"name" is too long (80 characters at most)');
	let expiresAt: string | null = null;
	if (b.expiresInDays != null && b.expiresInDays !== '' && b.expiresInDays !== 0) {
		const days = Number(b.expiresInDays);
		if (!Number.isFinite(days) || days < 1 || days > 3650) throw new BadRequest('"expiresInDays" must be 1–3650');
		expiresAt = new Date(now + Math.round(days) * 86_400_000).toISOString();
	}
	const scope: TokenScope = b.scope === 'upload' ? 'upload' : b.scope === 'mcp' ? 'mcp' : 'status';
	const options: TokenOptions =
		scope === 'upload' ? { upload: parseUploadTarget(b.upload) } : scope === 'mcp' ? { mcp: parseMcpOptions(b) } : b.bedClear === true ? { bedClear: true } : {};
	return { name, expiresAt, includeAddresses: scope === 'status' && b.includeAddresses === true, scope, options };
}

/** Creates a token and returns it in full — the only time it's ever available. */
export function createToken(input: TokenInput, by: Pick<User, 'id' | 'email'> | null): { token: string; record: ApiToken } {
	const scope = input.scope ?? 'status';
	const token = generateToken(scope === 'upload', prefixFor(scope));
	const id = randomUUID();
	const options = input.options && Object.keys(input.options).length ? JSON.stringify(input.options) : null;
	sqlite()
		.prepare(
			`INSERT INTO api_tokens (id, name, token_hash, prefix, scope, include_addresses, options, expires_at, created_by, created_by_email, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, input.name, hashToken(token), token.slice(0, prefixFor(scope).length + 6), scope, input.includeAddresses ? 1 : 0, options, input.expiresAt, by?.id ?? null, by?.email ?? null, new Date().toISOString());
	return { token, record: getToken(id)! };
}

export function revokeToken(id: string): boolean {
	return Number(sqlite().prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id).changes) > 0;
}

export function deleteToken(id: string): boolean {
	return Number(sqlite().prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes) > 0;
}

// --- request authorization (used by hooks.server.ts) ------------------------------------

const failures = new Map<string, number[]>();
const FAIL_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 20;

function tooManyFailures(key: string): boolean {
	const now = Date.now();
	const recent = (failures.get(key) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
	failures.set(key, recent);
	return recent.length >= MAX_FAILURES;
}

export type StatusAuth = { ok: true; principal: TokenPrincipal } | { ok: false; status: number; message: string };

/**
 * Decides a request to a status route: GET/HEAD only, with a valid status token.
 * Repeated bad tokens from one address are throttled (20 per 5 minutes).
 */
export function authorizeStatusRequest(req: { method: string; path: string; headers: Headers; url: URL; ip?: string }): StatusAuth {
	if (!isStatusRoute(req.path)) return { ok: false, status: 404, message: 'Not found' };
	if (!tokenAllowed(req.method, req.path)) return { ok: false, status: 405, message: 'Only GET is supported' };
	const key = req.ip ?? 'unknown';
	if (tooManyFailures(key)) return { ok: false, status: 429, message: 'Too many invalid tokens; try again later' };
	const token = presentedToken(req.headers, req.url);
	if (!token) return { ok: false, status: 401, message: 'API token required (Authorization: Bearer ocm_…)' };
	const principal = verifyToken(token, 'status', req.ip);
	if (!principal) {
		failures.get(key)!.push(Date.now());
		return { ok: false, status: 401, message: 'Invalid, expired or revoked API token' };
	}
	return { ok: true, principal };
}

/**
 * Decides POST /api/status/<id>/bed-clear: a status token that allows confirming the
 * bed. Bad tokens are throttled like on the status routes.
 */
export function authorizeBedClearRequest(req: { method: string; headers: Headers; url: URL; ip?: string }): StatusAuth {
	if (req.method !== 'POST') return { ok: false, status: 405, message: 'Use POST' };
	const key = req.ip ?? 'unknown';
	if (tooManyFailures(key)) return { ok: false, status: 429, message: 'Too many invalid tokens; try again later' };
	const token = presentedToken(req.headers, req.url);
	if (!token) return { ok: false, status: 401, message: 'API token required (Authorization: Bearer ocm_…)' };
	const principal = verifyToken(token, 'status', req.ip);
	if (!principal) {
		failures.get(key)!.push(Date.now());
		return { ok: false, status: 401, message: 'Invalid, expired or revoked API token' };
	}
	if (!principal.options.bedClear) return { ok: false, status: 403, message: 'This token may not confirm the bed is clear' };
	return { ok: true, principal };
}

/** A token from `Authorization: Bearer …` only (MCP: no query-string tokens, no cookies). */
export function bearerToken(headers: Headers): string | null {
	const auth = headers.get('authorization');
	const m = auth ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
	return m ? m[1] : null;
}

/**
 * Decides a request to /mcp: an MCP token in `Authorization: Bearer ocx_…`. Bad tokens
 * are throttled like on the status routes. What the token may do (its creator's current
 * role and printers) is worked out per call, in mcp/principal.ts.
 */
export function authorizeMcpRequest(req: { headers: Headers; ip?: string }): StatusAuth {
	const key = req.ip ?? 'unknown';
	if (tooManyFailures(key)) return { ok: false, status: 429, message: 'Too many invalid tokens; try again later' };
	const token = bearerToken(req.headers);
	if (!token) return { ok: false, status: 401, message: 'MCP token required (Authorization: Bearer ocx_…)' };
	const principal = verifyToken(token, 'mcp', req.ip);
	if (!principal || !principal.options.mcp) {
		failures.get(key)!.push(Date.now());
		return { ok: false, status: 401, message: 'Invalid, expired or revoked MCP token' };
	}
	return { ok: true, principal };
}

/** The key a slicer sends: `X-Api-Key` (OctoPrint's header), `Authorization: Bearer`, or `?apikey=`. */
export function presentedUploadKey(headers: Headers, url: URL): string | null {
	const k = headers.get('x-api-key')?.trim();
	if (k) return k;
	const auth = headers.get('authorization');
	const m = auth ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
	if (m) return m[1];
	return url.searchParams.get('apikey') || null;
}

/**
 * Decides a request to the OctoPrint-compatible API (/octoprint/api/…): an upload key,
 * with or without its `ocm_` prefix (some slicers only take letters and digits).
 * OctoPrint answers a missing key with 401 and a wrong one with 403; so does this.
 */
export function authorizeUploadRequest(req: { headers: Headers; url: URL; ip?: string }): StatusAuth {
	const key = req.ip ?? 'unknown';
	if (tooManyFailures(key)) return { ok: false, status: 429, message: 'Too many invalid API keys; try again later' };
	const raw = presentedUploadKey(req.headers, req.url);
	if (!raw) return { ok: false, status: 401, message: 'API key required (X-Api-Key)' };
	const token = raw.startsWith(TOKEN_PREFIX) ? raw : TOKEN_PREFIX + raw;
	const principal = verifyToken(token, 'upload', req.ip);
	if (!principal || !principal.options.upload) {
		failures.get(key)!.push(Date.now());
		return { ok: false, status: 403, message: 'Invalid API key' };
	}
	return { ok: true, principal };
}

const lastTouched = new Map<string, number>();

/**
 * The token's principal if it's valid for `scope`: known, not revoked, not expired.
 * Records when it was last used (at most once a minute per token).
 */
export function verifyToken(token: string, scope: TokenScope, ip?: string): TokenPrincipal | null {
	if (!looksLikeToken(token)) return null;
	const r = sqlite().prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hashToken(token)) as Row | undefined;
	if (!r || !tokenMatches(token, r.token_hash as string)) return null;
	const t = toToken(r);
	if (t.revokedAt) return null;
	if (t.expiresAt && Date.parse(t.expiresAt) <= Date.now()) return null;
	if (t.scope !== scope) return null;
	const now = Date.now();
	if (now - (lastTouched.get(t.id) ?? 0) > 60_000) {
		lastTouched.set(t.id, now);
		sqlite().prepare('UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(new Date(now).toISOString(), ip ?? null, t.id);
	}
	return { id: t.id, name: t.name, scope: t.scope, includeAddresses: t.includeAddresses, options: t.options, createdById: t.createdById ?? null };
}
