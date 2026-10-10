import { json } from '@sveltejs/kit';
import { body, Forbidden, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { createSource, listSources, parseSourceInput } from '#lib/server/library/sources.ts';
import { visibleSources } from '#lib/server/library/service.ts';
import { describeSource } from '#lib/library.ts';
import type { RequestHandler } from './$types';

/**
 * Library sources. Everyone gets the ones they may use (name, kind, printers);
 * `?manage=1` gives admins the full configuration (never credentials).
 */
export const GET: RequestHandler = handler(async ({ locals, url }) => {
	if (url.searchParams.get('manage') === '1') {
		if (locals.user?.role !== 'admin') throw new Forbidden('Admins only');
		return json(listSources(), { headers: { 'cache-control': 'no-store' } });
	}
	return json(visibleSources(locals.user), { headers: { 'cache-control': 'no-store' } });
});

export const POST: RequestHandler = handler(async ({ locals, request }) => {
	const src = createSource(parseSourceInput(await body(request)));
	audit(locals, 'library.source.create', { detail: `${src.name} (${describeSource(src)})` });
	return json(src, { status: 201 });
});
