import { json, redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import '#lib/server/jobs/index.ts';
import { startJobs } from '#lib/server/jobs.ts';
import { authenticate } from '#lib/server/auth.ts';
import { publicUrl } from '#lib/server/origin.ts';
import { ADMIN_PAGES, adminOnlyApi, controlApi, printerIdFromPath, roleAllows } from '#lib/server/access.ts';
import { canSee } from '#lib/server/permissions.ts';
import { getPrinter } from '#lib/server/store.ts';
import { authorizeStatusRequest, isStatusRoute } from '#lib/server/api-tokens.ts';

export const init: ServerInit = () => {
	startJobs();
};

const PUBLIC = ['/login', '/setup', '/auth/oidc/', '/api/auth/', '/api/health'];

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;
	const method = event.request.method;
	const isApi = pathname.startsWith('/api/');

	// Writes must come from our own host. Browsers always send Origin on cross-site
	// and non-GET requests, so a mismatch means a forged request. (This replaces
	// SvelteKit's own CSRF check; see vite.config.ts.)
	// Hosts are compared (not full origins) so it works by IP, hostname, or
	// behind a TLS-terminating proxy without configuring ORIGIN.
	if (method !== 'GET' && method !== 'HEAD') {
		const origin = event.request.headers.get('origin');
		if (origin) {
			const h = event.request.headers;
			const allowed = [event.url.host, h.get('host'), h.get('x-forwarded-host')].filter(Boolean);
			let host = '';
			try {
				host = new URL(origin).host;
			} catch {}
			if (!allowed.includes(host)) return json({ message: 'Cross-origin request blocked' }, { status: 403 });
		}
	}

	const visible = publicUrl(event.url, event.request.headers);
	event.locals.origin = visible.origin;
	event.locals.secure = visible.protocol === 'https:';

	// Dashboard status routes take an API token (Bearer or ?token=) and nothing else:
	// no session, no cookies. Tokens are checked here only, so they open no other route.
	if (isStatusRoute(pathname)) {
		try {
			event.locals.ip = event.getClientAddress();
		} catch {}
		event.locals.auth = 'anonymous';
		event.locals.user = null;
		const auth = authorizeStatusRequest({ method, path: pathname, headers: event.request.headers, url: event.url, ip: event.locals.ip });
		if (!auth.ok) {
			const headers: Record<string, string> = auth.status === 401 ? { 'www-authenticate': 'Bearer' } : auth.status === 405 ? { allow: 'GET, HEAD' } : {};
			return json({ message: auth.message }, { status: auth.status, headers });
		}
		event.locals.apiToken = auth.principal;
		const response = await resolve(event);
		response.headers.set('X-Content-Type-Options', 'nosniff');
		response.headers.set('Referrer-Policy', 'no-referrer');
		return response;
	}

	const { state, user } = authenticate(event.cookies);
	event.locals.auth = state;
	event.locals.user = user;
	try {
		event.locals.ip = event.getClientAddress();
	} catch {}

	if (!PUBLIC.some((p) => pathname.startsWith(p))) {
		if (state === 'setup') {
			if (isApi) return json({ message: 'Setup required' }, { status: 401 });
			redirect(303, '/setup');
		}
		if (state === 'anonymous') {
			if (isApi) return json({ message: 'Not signed in' }, { status: 401 });
			redirect(303, `/login?next=${encodeURIComponent(pathname + event.url.search)}`);
		}
		const role = user?.role;
		if (role !== 'admin') {
			if (isApi && adminOnlyApi(method, pathname)) return json({ message: 'Admins only' }, { status: 403 });
			if (!isApi && ADMIN_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) redirect(303, '/');
		}
		if (isApi && controlApi(method, pathname) && !roleAllows(role, 'control')) {
			return json({ message: 'Your role can only watch printers' }, { status: 403 });
		}
		// Printers a user hasn't been given access to don't exist, as far as they can tell.
		const printerId = printerIdFromPath(pathname);
		const printer = printerId ? getPrinter(printerId) : undefined;
		if (printerId && (!printer || !canSee(user, printer))) {
			if (isApi) return json({ message: 'Printer not found' }, { status: 404 });
			redirect(303, '/');
		}
	}

	const response = await resolve(event);
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	return response;
};
