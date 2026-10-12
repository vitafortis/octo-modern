import { error } from '@sveltejs/kit';
import { canControl, canSee, withAccess } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { getPrinter } from '#lib/server/store.ts';
import { pluginInstalled } from '#lib/server/bedmesh.ts';
import { updateCount } from '#lib/server/plugins.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const p = getPrinter(params.id);
	if (!p || !canSee(locals.user, p)) error(404, 'Printer not found');
	// Care › Plugins & updates: OctoPrint printers, admins only.
	const plugins = locals.user?.role === 'admin' && p.kind === 'octoprint';
	return {
		printer: withAccess(locals.user, p),
		canControl: canControl(locals.user, p),
		/** Whatever the server already knows, so the first paint isn't empty. */
		snapshot: printers.snapshot(p.id) ?? null,
		/** Optional tabs: Care › Bed mesh needs the Bed Visualizer plugin; Care › Plugins & updates is for admins. */
		features: { bedmesh: await pluginInstalled(p.id), plugins },
		/** Updates the last background check found (the Care badge). */
		updates: plugins ? updateCount(p.id) : 0
	};
};
