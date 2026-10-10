/**
 * Route-level access rules, applied in hooks.server.ts before any handler runs.
 * Handlers check again where it matters (permissions.ts), so a rule missed here
 * doesn't open anything by itself.
 */
import type { Role } from '#lib/types.ts';

/** Pages only admins can open. */
export const ADMIN_PAGES = ['/settings', '/users', '/integrations', '/audit', '/discover'];

/** API calls only admins may make: users, settings, integrations, audit, backups, discovery, and adding/editing servers. */
export function adminOnlyApi(method: string, path: string): boolean {
	if (/^\/api\/(settings|users|integrations|audit|backup|discover)(\/|$)/.test(path)) return true;
	if (path === '/api/printers') return method !== 'GET';
	if (path === '/api/printers/test') return true;
	if (/^\/api\/printers\/[^/]+$/.test(path)) return method !== 'GET';
	return false;
}

/**
 * Printer API calls that change something on the printer (anything but GET/HEAD under
 * /api/printers/<id>/…): jobs, temperatures, connection, files, G-code. Operators
 * and admins only. New phase-2 routes are covered automatically.
 */
export function controlApi(method: string, path: string): boolean {
	if (method === 'GET' || method === 'HEAD') return false;
	return /^\/api\/printers\/[^/]+\/.+/.test(path) && !path.startsWith('/api/printers/test');
}

export function roleAllows(role: Role | undefined, need: 'admin' | 'control' | 'view'): boolean {
	if (!role) return false;
	if (need === 'admin') return role === 'admin';
	if (need === 'control') return role === 'admin' || role === 'operator';
	return true;
}

/** The printer a page or API path is scoped to, if any. */
export function printerIdFromPath(path: string): string | undefined {
	const m = /^\/(?:api\/printers|p)\/([^/]+)/.exec(path);
	return m && m[1] !== 'test' && m[1] !== 'status' ? decodeURIComponent(m[1]) : undefined;
}
