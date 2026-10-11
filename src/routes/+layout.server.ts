import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { visiblePrinters } from '#lib/server/permissions.ts';
import { ADMIN_PAGES } from '#lib/server/access.ts';
import { overdueCount } from '#lib/server/maintenance.ts';
import type { Viewer } from '#lib/types.ts';

export const load: LayoutServerLoad = ({ locals, url }) => {
	// Reading url.pathname makes this load rerun on every client-side navigation,
	// so the page checks below apply to in-app navigation, not just full page loads.
	const path = url.pathname;
	const user = locals.user;
	if (user && user.role !== 'admin' && ADMIN_PAGES.some((p) => path === p || path.startsWith(`${p}/`))) redirect(303, '/');

	const viewer: Viewer | null = user ? { email: user.email, name: user.name, role: user.role, hasPassword: user.hasPassword, sso: user.sso } : null;
	const printers = visiblePrinters(user);
	return {
		auth: locals.auth,
		version: __APP_VERSION__,
		viewer,
		printers,
		/** Overdue maintenance tasks, for the sidebar badge. */
		maintenanceOverdue: user ? overdueCount(printers.map((p) => p.id)) : 0
	};
};
