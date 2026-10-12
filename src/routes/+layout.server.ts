import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { visiblePrinters } from '#lib/server/permissions.ts';
import { ADMIN_PAGES } from '#lib/server/access.ts';
import { listTasks } from '#lib/server/maintenance.ts';
import { spoolmanConfigured } from '#lib/server/spools/spoolman.ts';
import type { Viewer } from '#lib/types.ts';

export const load: LayoutServerLoad = ({ locals, url }) => {
	// Reading url.pathname makes this load rerun on every client-side navigation,
	// so the page checks below apply to in-app navigation, not just full page loads.
	const path = url.pathname;
	const user = locals.user;
	if (user && user.role !== 'admin' && ADMIN_PAGES.some((p) => path === p || path.startsWith(`${p}/`))) redirect(303, '/');

	const viewer: Viewer | null = user ? { email: user.email, name: user.name, role: user.role, hasPassword: user.hasPassword, sso: user.sso } : null;
	const printers = visiblePrinters(user);
	const tasks = user ? listTasks(printers.map((p) => p.id)) : [];
	return {
		auth: locals.auth,
		version: __APP_VERSION__,
		viewer,
		printers,
		/** Maintenance tasks on the printers this user sees (the sidebar lists Maintenance once there are any), and how many are overdue (its badge). */
		maintenanceTasks: tasks.length,
		maintenanceOverdue: tasks.filter((t) => t.status === 'overdue').length,
		/** Spoolman is set up: the sidebar lists Filament. */
		spoolman: !!user && spoolmanConfigured()
	};
};
