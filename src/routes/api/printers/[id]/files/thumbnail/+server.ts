import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { viewTarget } from '#lib/server/control.ts';
import type { RequestHandler } from './$types';

/** A slicer thumbnail (OctoPrint: `?src=plugin/<plugin>/thumbnail/…`; Klipper: `.thumbs/…png`), fetched with the key. */
export const GET: RequestHandler = handler(async ({ params, locals, url }) => {
	const { backend } = viewTarget(locals.user, params.id);
	const src = backend.thumbnailSource(url.searchParams.get('src'));
	if (!src) return json({ message: 'Not a thumbnail path' }, { status: 400 });
	const res = await backend.thumbnail(src);
	const type = res.headers.get('content-type') ?? '';
	if (!type.startsWith('image/')) {
		await res.body?.cancel();
		return json({ message: 'Not an image' }, { status: 502 });
	}
	return new Response(res.body, { headers: { 'content-type': type, 'cache-control': 'private, max-age=3600' } });
});
