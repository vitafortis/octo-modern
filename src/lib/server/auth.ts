import type { Cookies } from '@sveltejs/kit';
import { config } from './config.ts';
import { hashPassword, randomToken, sha256 } from './crypto.ts';
import { countUsers, createSession, createUser, deleteSession, getKv, sessionUser, setKv, touchUserLogin } from './store.ts';
import type { Role, User } from '#lib/types.ts';

export const SESSION_COOKIE = 'ocm_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `open`: sign-in isn't required, so visitors get the guest role (see accessSettings). */
export type AuthState = 'disabled' | 'setup' | 'anonymous' | 'open' | 'authenticated';

export interface AccessSettings {
	/** Visitors must sign in to octo·modern. Printers stay connected with their saved keys either way. */
	requireSignIn: boolean;
	/** What visitors may do when sign-in isn't required. Admin always needs an account. */
	guestRole: Exclude<Role, 'admin'>;
}

const ACCESS_KEY = 'settings:access';

export function accessSettings(): AccessSettings {
	const s = getKv<Partial<AccessSettings>>(ACCESS_KEY, {});
	return { requireSignIn: s.requireSignIn !== false, guestRole: s.guestRole === 'operator' ? 'operator' : 'viewer' };
}

export function saveAccessSettings(s: AccessSettings) {
	setKv(ACCESS_KEY, s);
}

/** Stand-in user when OCM_AUTH=disabled. */
const OPEN_USER: User = {
	id: 'open',
	email: 'admin',
	name: 'Admin',
	role: 'admin',
	hasPassword: false,
	sso: false,
	disabled: false,
	printerAccess: 'all',
	createdAt: new Date(0).toISOString(),
	lastLoginAt: null
};

/** The stand-in admin when OCM_AUTH=disabled (tokens created then act as it), else null. */
export function openUser(): User | null {
	return config.authDisabled ? OPEN_USER : null;
}

function guestUser(role: Exclude<Role, 'admin'>): User {
	return { ...OPEN_USER, id: 'guest', email: 'guest', name: 'Guest', role };
}

let bootstrapped = false;

/** OCM_ADMIN_EMAIL + OCM_ADMIN_PASSWORD create the first admin, so headless installs skip setup. */
function bootstrapAdmin() {
	bootstrapped = true;
	const b = config.bootstrapAdmin;
	if (!b || countUsers() > 0) return;
	if (b.password.length < 8) {
		console.warn('[octo-modern] OCM_ADMIN_PASSWORD must be at least 8 characters; showing the setup wizard instead.');
		return;
	}
	createUser({ email: b.email, name: b.name, role: 'admin', passwordHash: hashPassword(b.password) });
	console.log(`[octo-modern] Created admin ${b.email} from OCM_ADMIN_EMAIL.`);
}

export function authenticate(cookies: Cookies): { state: AuthState; user: User | null } {
	if (config.authDisabled) return { state: 'disabled', user: OPEN_USER };
	if (!bootstrapped) bootstrapAdmin();
	if (countUsers() === 0) return { state: 'setup', user: null };
	const token = cookies.get(SESSION_COOKIE);
	const user = token ? sessionUser(sha256(token)) : undefined;
	if (user) return { state: 'authenticated', user };
	const access = accessSettings();
	return access.requireSignIn ? { state: 'anonymous', user: null } : { state: 'open', user: guestUser(access.guestRole) };
}

export function startSession(cookies: Cookies, userId: string, secure: boolean) {
	const token = randomToken();
	createSession(sha256(token), userId, SESSION_TTL_MS);
	touchUserLogin(userId);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		// Lax (not Strict) so the cookie survives the redirect back from an SSO provider.
		// Cross-site writes are still blocked by the Origin check in hooks.server.ts.
		sameSite: 'lax',
		secure,
		maxAge: SESSION_TTL_MS / 1000
	});
}

export function endSession(cookies: Cookies) {
	const token = cookies.get(SESSION_COOKIE);
	if (token) deleteSession(sha256(token));
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

// Simple in-memory login throttle: 10 attempts per 5 minutes per client address.
const attempts = new Map<string, number[]>();
export function throttled(key: string): boolean {
	const now = Date.now();
	const recent = (attempts.get(key) ?? []).filter((t) => now - t < 5 * 60_000);
	recent.push(now);
	attempts.set(key, recent);
	return recent.length > 10;
}

/** Matches an email against patterns like `alice@example.com`, `*@example.com` or `*`. */
export function emailMatches(email: string, patterns: string[]): boolean {
	const e = email.trim().toLowerCase();
	return patterns.some((raw) => {
		const p = raw.trim().toLowerCase();
		if (!p) return false;
		if (p === '*') return true;
		if (p.startsWith('*@')) return e.endsWith(p.slice(1));
		if (p.startsWith('@')) return e.endsWith(p);
		return e === p;
	});
}
