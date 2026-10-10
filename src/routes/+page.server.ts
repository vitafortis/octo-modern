import { redirect } from '@sveltejs/kit';
import { visiblePrinters } from '#lib/server/permissions.ts';
import type { PageServerLoad } from './$types';

/** With exactly one printer, the app is that printer. */
export const load: PageServerLoad = ({ locals }) => {
	const list = visiblePrinters(locals.user);
	if (list.length === 1) redirect(307, `/p/${list[0].id}`);
};
