import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { cameraFor, cameraHeaders } from '#lib/server/octoprint/webcam.ts';
import { httpFetch } from '#lib/server/octoprint/transport.ts';
import { toOctoPrintError } from '#lib/server/octoprint/errors.ts';
import { getApiKey } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/**
 * A camera's MJPEG stream (`?cam=<id>`), relayed as-is. Backpressure: the response
 * body is the upstream body, so a slow browser slows the reads from the camera
 * (adapter-node waits for 'drain'). When the browser goes away, SvelteKit cancels the
 * body, which aborts the upstream request; the request's abort signal does the same.
 */
export const GET: RequestHandler = handler(async ({ params, locals, request, url }) => {
	const p = requirePrinter(locals.user, params.id);
	const cam = await cameraFor(p, url.searchParams.get('cam'));
	if (!cam?.streamUrl) return json({ message: 'This printer has no webcam stream URL' }, { status: 404 });
	if (cam.kind !== 'mjpeg') return json({ message: `This is a ${cam.kind?.toUpperCase()} stream; open it directly`, externalUrl: cam.streamUrl }, { status: 415 });

	// Time out only while connecting; the stream itself runs until the browser leaves.
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 10_000);
	const onAbort = () => abort.abort();
	request.signal.addEventListener('abort', onAbort, { once: true });
	let res: Response;
	try {
		res = await httpFetch(cam.streamUrl, { headers: cameraHeaders(p, cam.streamUrl, getApiKey(p.id)), signal: abort.signal }, p.verifyTls);
	} catch (err) {
		request.signal.removeEventListener('abort', onAbort);
		throw toOctoPrintError(abort.signal.reason ?? err, new URL(cam.streamUrl).host);
	} finally {
		clearTimeout(timer);
	}
	const type = res.headers.get('content-type') ?? '';
	if (!res.ok || !/^(multipart\/x-mixed-replace|image\/)/i.test(type)) {
		abort.abort();
		return json({ message: `The webcam stream answered ${res.status}${type ? ` (${type.split(';')[0]})` : ''}, not MJPEG` }, { status: 502 });
	}
	const upstream = res.body!.getReader();
	// Our own stream around the upstream one, so a cancel from the browser side always
	// reaches the camera request (and nothing keeps reading into memory).
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const { done, value } = await upstream.read();
					if (done) controller.close();
					else controller.enqueue(value);
				} catch (err) {
					controller.error(err);
				}
			},
			cancel() {
				abort.abort();
				void upstream.cancel().catch(() => {});
			}
		},
		{ highWaterMark: 1 }
	);
	return new Response(body, { headers: { 'content-type': type, 'cache-control': 'no-store, no-cache', 'x-accel-buffering': 'no' } });
});
