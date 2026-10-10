import { handler, NotFound } from '#lib/server/http.ts';
import { fileThumbnail, requireSource } from '#lib/server/library/service.ts';
import type { RequestHandler } from './$types';

/** The slicer thumbnail embedded in a file (`?path=`; `&v=<size-mtime>` makes it cacheable). */
export const GET: RequestHandler = handler(async ({ locals, params, url }) => {
	const src = requireSource(locals.user, params.source);
	const t = await fileThumbnail(src, url.searchParams.get('path') ?? '');
	if (!t) throw new NotFound('No thumbnail');
	const versioned = url.searchParams.get('v') === t.version;
	return new Response(Buffer.from(t.data), {
		headers: {
			'content-type': t.type,
			'cache-control': versioned ? 'private, max-age=31536000, immutable' : 'private, no-cache',
			'content-security-policy': "default-src 'none'"
		}
	});
});
