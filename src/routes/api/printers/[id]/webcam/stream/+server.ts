import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { cameraHeaders, webcamInfo } from '#lib/server/octoprint/webcam.ts';
import { httpFetch } from '#lib/server/octoprint/transport.ts';
import { toOctoPrintError } from '#lib/server/octoprint/errors.ts';
import { getApiKey } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** The webcam's MJPEG stream, relayed until the browser disconnects. */
export const GET: RequestHandler = handler(async ({ params, locals, request }) => {
	const p = requirePrinter(locals.user, params.id);
	const w = await webcamInfo(p);
	if (!w.streamUrl) return json({ message: 'No webcam stream URL for this printer' }, { status: 404 });
	// Time out only while connecting; the stream itself runs until the browser leaves.
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 10_000);
	request.signal.addEventListener('abort', () => abort.abort());
	let res: Response;
	try {
		res = await httpFetch(w.streamUrl, { headers: cameraHeaders(p, w.streamUrl, getApiKey(p.id)), signal: abort.signal }, p.verifyTls);
	} catch (err) {
		throw toOctoPrintError(abort.signal.reason ?? err, new URL(w.streamUrl).host);
	} finally {
		clearTimeout(timer);
	}
	const type = res.headers.get('content-type') ?? '';
	if (!res.ok || !/^(multipart\/x-mixed-replace|image\/)/.test(type)) {
		await res.body?.cancel();
		return json({ message: `The webcam stream answered ${res.status}${type ? ` (${type.split(';')[0]})` : ''}` }, { status: 502 });
	}
	return new Response(res.body, { headers: { 'content-type': type, 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
});
