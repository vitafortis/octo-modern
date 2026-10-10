import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { cameraHeaders, webcamInfo } from '#lib/server/octoprint/webcam.ts';
import { httpFetch } from '#lib/server/octoprint/transport.ts';
import { toOctoPrintError } from '#lib/server/octoprint/errors.ts';
import { getApiKey } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** One webcam frame, fetched by the server. 404 when the printer has no webcam. */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const p = requirePrinter(locals.user, params.id);
	const w = await webcamInfo(p);
	if (!w.snapshotUrl) return json({ message: 'No webcam snapshot URL for this printer' }, { status: 404 });
	let res: Response;
	try {
		res = await httpFetch(w.snapshotUrl, { headers: cameraHeaders(p, w.snapshotUrl, getApiKey(p.id)), signal: AbortSignal.timeout(8_000) }, p.verifyTls);
	} catch (err) {
		throw toOctoPrintError(err, new URL(w.snapshotUrl).host);
	}
	const type = res.headers.get('content-type') ?? '';
	if (!res.ok || !type.startsWith('image/')) {
		await res.body?.cancel();
		return json({ message: `The webcam answered ${res.status}${type ? ` (${type.split(';')[0]})` : ''}` }, { status: 502 });
	}
	return new Response(res.body, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
});
