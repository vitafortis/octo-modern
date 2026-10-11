import { json } from '@sveltejs/kit';
import { confirmBedClear } from '#lib/server/queue/service.ts';
import type { RequestHandler } from './$types';

/**
 * "Bed is clear" for automations and hardware buttons: POST with a status token that
 * allows it (`Authorization: Bearer ocm_…`). hooks.server.ts checks the token.
 */
export const POST: RequestHandler = ({ params, locals }) => {
	const token = locals.apiToken;
	if (!token?.options.bedClear) return json({ message: 'A status token that may confirm the bed is required' }, { status: 401 });
	const r = confirmBedClear(locals, params.id, `token “${token.name}”`);
	if (!r.ok) return json({ message: r.message }, { status: r.message === 'Printer not found' ? 404 : 409 });
	return json({ ok: true });
};
