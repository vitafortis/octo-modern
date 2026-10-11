import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { audit, requireControl } from '#lib/server/permissions.ts';
import { dismiss } from '#lib/server/detect/service.ts';
import type { RequestHandler } from './$types';

/** "This is a false alarm": failure detection stays off for the rest of this print. */
export const POST: RequestHandler = handler(({ params, locals }) => {
	const p = requireControl(locals.user, params.id);
	const by = locals.user?.name || locals.user?.email || 'someone';
	let s;
	try {
		s = dismiss(p.id, by);
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	audit(locals, 'detect.dismiss', { printer: p, detail: `${s.print?.file ?? 'print'}: false alarm at score ${s.score != null ? Math.round(s.score * 100) : '—'}%` });
	return json(s);
});
