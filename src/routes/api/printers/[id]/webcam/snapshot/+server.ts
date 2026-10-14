import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { fetchSnapshot } from '#lib/server/octoprint/webcam.ts';
import { OctoPrintError } from '#lib/server/octoprint/errors.ts';
import type { RequestHandler } from './$types';

/** One frame from a camera (`?cam=<id>`, default the first), fetched by the server. */
export const GET: RequestHandler = handler(async ({ params, locals, url }) => {
	const p = requirePrinter(locals.user, params.id);
	try {
		const { type, res } = await fetchSnapshot(p, url.searchParams.get('cam'));
		return new Response(res.body, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
	} catch (err) {
		if (err instanceof OctoPrintError && (err.code === 'NO_SNAPSHOT' || err.code === 'BAD_SNAPSHOT')) return json({ message: err.message }, { status: err.status });
		throw err;
	}
});
