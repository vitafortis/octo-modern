import { json } from '@sveltejs/kit';
import { BadRequest, body, handler, NotFound } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { getPrinter, getUser, listGrants, setGrants, updateUser } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(({ params }) => {
	const user = getUser(params.id);
	if (!user) throw new NotFound('User not found');
	return json({ printerAccess: user.printerAccess, printers: listGrants(user.id) });
});

/** Which printers a non-admin sees: all of them, or only the listed ones. */
export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	const user = getUser(params.id);
	if (!user) throw new NotFound('User not found');
	const b = await body(request);
	if (b.printerAccess !== 'all' && b.printerAccess !== 'selected') throw new BadRequest('"printerAccess" must be all or selected');
	if (!Array.isArray(b.printers)) throw new BadRequest('"printers" must be a list of printer ids');
	const ids = b.printers.filter((id): id is string => typeof id === 'string');
	updateUser(user.id, { printerAccess: b.printerAccess });
	setGrants(user.id, ids);
	const names = ids.map((id) => getPrinter(id)?.name ?? id).join(', ') || 'none';
	audit(locals, 'user.access', { detail: `${user.email}: ${b.printerAccess === 'all' ? 'all printers' : `only ${names}`}` });
	return json({ printerAccess: b.printerAccess, printers: listGrants(user.id) });
});
