import { json } from '@sveltejs/kit';
import { body, Forbidden, handler, NotFound } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { deleteSource, getSource, parseSourceInput, updateSource } from '#lib/server/library/sources.ts';
import { describeSource } from '#lib/library.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(async ({ locals, params }) => {
	if (locals.user?.role !== 'admin') throw new Forbidden('Admins only');
	const src = getSource(params.id);
	if (!src) throw new NotFound('Library source not found');
	return json(src);
});

/** Updates a source. Secret fields left out (or empty) keep their stored values. */
export const PUT: RequestHandler = handler(async ({ locals, params, request }) => {
	const existing = getSource(params.id);
	if (!existing) throw new NotFound('Library source not found');
	const src = updateSource(params.id, parseSourceInput(await body(request), { existing }))!;
	audit(locals, 'library.source.update', { detail: `${src.name} (${describeSource(src)})${src.writable ? ', writable' : ''}` });
	return json(src);
});

export const DELETE: RequestHandler = handler(async ({ locals, params }) => {
	const src = getSource(params.id);
	if (!src || !deleteSource(params.id)) throw new NotFound('Library source not found');
	audit(locals, 'library.source.delete', { detail: src.name });
	return json({ ok: true });
});
