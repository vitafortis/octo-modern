import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRole, type Role } from '#lib/types.ts';

function list(value: string | undefined): string[] {
	return (value ?? '')
		.split(/[,;\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function num(value: string | undefined, fallback: number, min: number, max: number): number {
	const n = Number(value);
	return Number.isFinite(n) && value !== undefined && value !== '' ? Math.min(max, Math.max(min, n)) : fallback;
}

/** True when this process itself runs inside a container. */
export const IN_CONTAINER = existsSync('/.dockerenv') || existsSync('/run/.containerenv');

export const config = {
	dataDir: resolve(process.env.OCM_DATA_DIR ?? './data'),
	/** Optional master secret. When unset, a random key is generated in the data dir. */
	secretKey: process.env.OCM_SECRET_KEY,
	/** Creates the first admin on start (skips the setup wizard). */
	bootstrapAdmin:
		process.env.OCM_ADMIN_EMAIL && process.env.OCM_ADMIN_PASSWORD
			? { email: process.env.OCM_ADMIN_EMAIL.trim(), password: process.env.OCM_ADMIN_PASSWORD, name: process.env.OCM_ADMIN_NAME?.trim() || null }
			: undefined,
	/** `disabled` turns off the login screen — only for fully trusted networks. */
	authDisabled: process.env.OCM_AUTH === 'disabled',
	/**
	 * `disabled` hides the email/password form (SSO only); `enabled` forces it on,
	 * overriding the UI setting — the break-glass if SSO is misconfigured.
	 */
	localLogin: (process.env.OCM_LOCAL_LOGIN === 'disabled' ? 'disabled' : process.env.OCM_LOCAL_LOGIN === 'enabled' ? 'enabled' : undefined) as
		| 'disabled'
		| 'enabled'
		| undefined,
	oidc: process.env.OCM_OIDC_ISSUER
		? {
				issuer: process.env.OCM_OIDC_ISSUER,
				clientId: process.env.OCM_OIDC_CLIENT_ID ?? '',
				clientSecret: process.env.OCM_OIDC_CLIENT_SECRET,
				/** Label on the login button. */
				name: process.env.OCM_OIDC_NAME ?? 'SSO',
				scopes: process.env.OCM_OIDC_SCOPES ?? 'openid email profile',
				/** Override when the public URL can't be inferred (defaults to <origin>/auth/oidc/callback). */
				redirectUri: process.env.OCM_OIDC_REDIRECT_URI,
				/** Email patterns that may create an account on first login, e.g. `*@example.com`. */
				autoCreate: list(process.env.OCM_OIDC_AUTO_CREATE),
				/** Email patterns that get the admin role when auto-created. */
				adminEmails: list(process.env.OCM_OIDC_ADMIN_EMAILS),
				defaultRole: (isRole(process.env.OCM_OIDC_DEFAULT_ROLE) ? process.env.OCM_OIDC_DEFAULT_ROLE : 'viewer') as Role
			}
		: undefined,
	/** How often printers nobody is watching are polled for the sidebar and status API. */
	pollIntervalMs: num(process.env.OCM_POLL_INTERVAL_MS, 10_000, 2_000, 600_000),
	/** Timeout for each request to OctoPrint. */
	requestTimeoutMs: num(process.env.OCM_REQUEST_TIMEOUT_MS, 10_000, 1_000, 120_000),
	/** Push update rate: OctoPrint sends one update every 500 ms × this. */
	pushThrottle: num(process.env.OCM_PUSH_THROTTLE, 2, 1, 20),
	/** Minutes of temperature history kept in memory per printer. */
	tempHistoryMinutes: num(process.env.OCM_TEMP_HISTORY_MINUTES, 30, 5, 240)
};
