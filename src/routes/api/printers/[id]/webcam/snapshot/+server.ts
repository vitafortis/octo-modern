import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { cameraFor, cameraHeaders } from '#lib/server/octoprint/webcam.ts';
import { httpFetch } from '#lib/server/octoprint/transport.ts';
import { toOctoPrintError } from '#lib/server/octoprint/errors.ts';
import { getApiKey } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** One frame from a camera (`?cam=<id>`, default the first), fetched by the server. */
export const GET: RequestHandler = handler(async ({ params, locals, url }) => {
	const p = requirePrinter(locals.user, params.id);
	const cam = await cameraFor(p, url.searchParams.get('cam'));
	if (!cam?.snapshotUrl) return json({ message: 'This printer has no webcam snapshot URL' }, { status: 404 });
	let res: Response;
	try {
		res = await httpFetch(cam.snapshotUrl, { headers: cameraHeaders(p, cam.snapshotUrl, getApiKey(p.id)), signal: AbortSignal.timeout(8_000) }, p.verifyTls);
	} catch (err) {
		throw toOctoPrintError(err, new URL(cam.snapshotUrl).host);
	}
	const type = res.headers.get('content-type') ?? '';
	if (!res.ok || !type.startsWith('image/')) {
		await res.body?.cancel();
		return json({ message: `The webcam answered ${res.status}${type ? ` (${type.split(';')[0]})` : ''}` }, { status: 502 });
	}
	return new Response(res.body, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
});
