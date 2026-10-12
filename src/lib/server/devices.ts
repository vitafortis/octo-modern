/**
 * Device tokens: what the Android app uses to call the API from native code (progress
 * notifications, the home-screen widget) without the WebView's session cookie.
 *
 * - Issued to a signed-in session (POST /api/account/devices), labelled with the device's
 *   name, one per app install. `ocd_` + 32 random bytes (base64url), shown once; only its
 *   SHA-256 is stored.
 * - The token acts as its user: the user's current role and printer access apply on every
 *   request (read live, so role changes and disabling the account take effect at once).
 * - Scoped: it opens only the routes the app needs (DEVICE_ROUTES) — printer list and
 *   status, one printer's state and webcam snapshot, pause/resume/cancel, and the device's
 *   own record. Everything else answers 403, so a leaked token can't change settings,
 *   users, files or anything an admin could.
 * - Revocable from My account, and by the app itself when you sign out there.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { sha256 } from './crypto.ts';
import { BadRequest } from './http.ts';
import { getUser, sqlite } from './store.ts';
import type { User } from '#lib/types.ts';
import type { LinkedDevice } from '#lib/devices.ts';

export const DEVICE_PREFIX = 'ocd_';

export interface DeviceToken {
	id: string;
	userId: string;
	name: string;
	/** `android` for now. */
	platform: string;
	/** First characters, to tell tokens apart (`ocd_AbCd…`). */
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
	lastUsedIp: string | null;
	revokedAt: string | null;
}

/** What hooks.server.ts sets on event.locals.device after a device token authenticated. */
export interface DevicePrincipal {
	id: string;
	name: string;
}

type Row = Record<string, unknown>;

function toDevice(r: Row): DeviceToken {
	return {
		id: r.id as string,
		userId: r.user_id as string,
		name: r.name as string,
		platform: r.platform as string,
		prefix: r.prefix as string,
		createdAt: r.created_at as string,
		lastUsedAt: (r.last_used_at as string) ?? null,
		lastUsedIp: (r.last_used_ip as string) ?? null,
		revokedAt: (r.revoked_at as string) ?? null
	};
}

/** What the API shows of a device (never its hash). */
export function publicDevice(d: DeviceToken, currentId?: string): LinkedDevice {
	return {
		id: d.id,
		name: d.name,
		platform: d.platform,
		prefix: d.prefix,
		createdAt: d.createdAt,
		lastUsedAt: d.lastUsedAt,
		revokedAt: d.revokedAt,
		...(currentId === d.id ? { current: true } : {})
	};
}

export const hashDeviceToken = (token: string) => sha256(token);

export function generateDeviceToken(): string {
	return DEVICE_PREFIX + randomBytes(32).toString('base64url');
}

export function looksLikeDeviceToken(token: string): boolean {
	return token.startsWith(DEVICE_PREFIX) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(DEVICE_PREFIX.length));
}

/** `Authorization: Bearer ocd_…` only (never a query parameter: URLs end up in logs). */
export function presentedDeviceToken(headers: Headers): string | null {
	const auth = headers.get('authorization');
	const m = auth ? /^Bearer\s+(ocd_\S+)\s*$/i.exec(auth) : null;
	return m ? m[1] : null;
}

export const MAX_DEVICES_PER_USER = 20;

export function parseDeviceInput(body: unknown): { name: string; platform: string } {
	if (!body || typeof body !== 'object') throw new BadRequest('Expected a JSON object');
	const b = body as Record<string, unknown>;
	const name = typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim() : '';
	if (!name) throw new BadRequest('"name" is required');
	if (name.length > 80) throw new BadRequest('"name" is too long (80 characters at most)');
	const platform = b.platform === undefined ? 'android' : b.platform;
	if (platform !== 'android') throw new BadRequest('"platform" must be "android"');
	return { name, platform };
}

/** Devices of one user, active first, newest first. */
export function listDevices(userId: string): DeviceToken[] {
	return (sqlite().prepare('SELECT * FROM device_tokens WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC').all(userId) as Row[]).map(toDevice);
}

export function getDevice(id: string): DeviceToken | undefined {
	const r = sqlite().prepare('SELECT * FROM device_tokens WHERE id = ?').get(id) as Row | undefined;
	return r && toDevice(r);
}

/**
 * Issues a token for one of `user`'s devices and returns it in full — the only time it's
 * available. Older revoked entries beyond the per-user limit are dropped; too many active
 * devices is an error.
 */
export function createDevice(user: Pick<User, 'id'>, input: { name: string; platform: string }): { token: string; device: DeviceToken } {
	const db = sqlite();
	const active = (db.prepare('SELECT count(*) AS n FROM device_tokens WHERE user_id = ? AND revoked_at IS NULL').get(user.id) as { n: number }).n;
	if (active >= MAX_DEVICES_PER_USER) throw new BadRequest(`You have ${active} linked devices; remove one under My account first`);
	db.prepare(
		`DELETE FROM device_tokens WHERE user_id = ? AND revoked_at IS NOT NULL AND id NOT IN
		 (SELECT id FROM device_tokens WHERE user_id = ? AND revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 10)`
	).run(user.id, user.id);
	const token = generateDeviceToken();
	const id = randomUUID();
	db.prepare('INSERT INTO device_tokens (id, user_id, name, platform, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
		id,
		user.id,
		input.name,
		input.platform,
		hashDeviceToken(token),
		token.slice(0, DEVICE_PREFIX.length + 6),
		new Date().toISOString()
	);
	return { token, device: getDevice(id)! };
}

/** Revokes one of the user's devices. False when it isn't theirs or is already revoked. */
export function revokeDevice(userId: string, id: string): boolean {
	return Number(sqlite().prepare('UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id, userId).changes) > 0;
}

/** Forgets a revoked device entry. */
export function deleteDevice(userId: string, id: string): boolean {
	return Number(sqlite().prepare('DELETE FROM device_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NOT NULL').run(id, userId).changes) > 0;
}

// --- request authorization (hooks.server.ts) ---------------------------------------------

/**
 * What a device token may call. Everything else is refused before any handler runs.
 * Job control is limited to pause/resume/cancel by `deviceJobCommandAllowed`.
 */
const DEVICE_ROUTES: { method: string; re: RegExp }[] = [
	{ method: 'GET', re: /^\/api\/printers\/?$/ },
	{ method: 'GET', re: /^\/api\/printers\/status\/?$/ },
	{ method: 'GET', re: /^\/api\/printers\/[^/]+\/state\/?$/ },
	{ method: 'GET', re: /^\/api\/printers\/[^/]+\/webcam\/snapshot\/?$/ },
	{ method: 'POST', re: /^\/api\/printers\/[^/]+\/job\/?$/ },
	{ method: 'GET', re: /^\/api\/account\/devices\/current\/?$/ },
	{ method: 'DELETE', re: /^\/api\/account\/devices\/current\/?$/ }
];

export function deviceRouteAllowed(method: string, path: string): boolean {
	const m = method === 'HEAD' ? 'GET' : method;
	return DEVICE_ROUTES.some((r) => r.method === m && r.re.test(path));
}

export const DEVICE_JOB_COMMANDS = ['pause', 'resume', 'cancel'];

/** Job commands a device may send: pausing, resuming and cancelling, not starting prints. */
export function deviceJobCommandAllowed(body: unknown): boolean {
	return !!body && typeof body === 'object' && DEVICE_JOB_COMMANDS.includes((body as Record<string, unknown>).command as string);
}

export const isDeviceJobRoute = (method: string, path: string) => method === 'POST' && /^\/api\/printers\/[^/]+\/job\/?$/.test(path);

const failures = new Map<string, number[]>();
const FAIL_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 20;

function tooManyFailures(key: string): boolean {
	const now = Date.now();
	const recent = (failures.get(key) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
	failures.set(key, recent);
	return recent.length >= MAX_FAILURES;
}

/** Stand-in for OCM_AUTH=disabled (mirrors auth.ts). */
function openUser(): User {
	return { id: 'open', email: 'admin', name: 'Admin', role: 'admin', hasPassword: false, sso: false, disabled: false, printerAccess: 'all', createdAt: new Date(0).toISOString(), lastLoginAt: null };
}

const lastTouched = new Map<string, number>();

/** The device and its user when the token is known, not revoked, and the account is active. */
export function verifyDeviceToken(token: string, ip?: string): { device: DeviceToken; user: User } | null {
	if (!looksLikeDeviceToken(token)) return null;
	const r = sqlite().prepare('SELECT * FROM device_tokens WHERE token_hash = ?').get(hashDeviceToken(token)) as Row | undefined;
	if (!r) return null;
	const a = Buffer.from(hashDeviceToken(token), 'hex');
	const b = Buffer.from(r.token_hash as string, 'hex');
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	const device = toDevice(r);
	if (device.revokedAt) return null;
	const user = device.userId === 'open' ? (config.authDisabled ? openUser() : undefined) : getUser(device.userId);
	if (!user || user.disabled) return null;
	const now = Date.now();
	if (now - (lastTouched.get(device.id) ?? 0) > 60_000) {
		lastTouched.set(device.id, now);
		sqlite().prepare('UPDATE device_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(new Date(now).toISOString(), ip ?? null, device.id);
	}
	return { device, user };
}

export type DeviceAuth = { ok: true; device: DeviceToken; user: User } | { ok: false; status: number; message: string };

/**
 * Decides a request that carries `Authorization: Bearer ocd_…`: a valid token, on a route
 * devices may use. Repeated bad tokens from one address are throttled (20 per 5 minutes).
 */
export function authorizeDeviceRequest(req: { method: string; path: string; headers: Headers; ip?: string }): DeviceAuth {
	const key = req.ip ?? 'unknown';
	if (tooManyFailures(key)) return { ok: false, status: 429, message: 'Too many invalid tokens; try again later' };
	const token = presentedDeviceToken(req.headers);
	if (!token) return { ok: false, status: 401, message: 'Device token required (Authorization: Bearer ocd_…)' };
	const found = verifyDeviceToken(token, req.ip);
	if (!found) {
		failures.get(key)!.push(Date.now());
		return { ok: false, status: 401, message: 'Invalid or revoked device token' };
	}
	if (!deviceRouteAllowed(req.method, req.path)) return { ok: false, status: 403, message: 'Device tokens can’t use this API' };
	return { ok: true, ...found };
}

/** Test hook: clears the failure counters. */
export function resetDeviceThrottle() {
	failures.clear();
}
