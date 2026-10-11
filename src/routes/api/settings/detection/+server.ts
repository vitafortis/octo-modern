import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { globalInfo, saveGlobal } from '#lib/server/detect/settings.ts';
import type { RequestHandler } from './$types';

/** Failure detection's ML API settings (admins; the token only as `hasToken`). */
export const GET: RequestHandler = handler(() => json(globalInfo()));

/** `{ mlApiUrl?, token?, publicUrl? }`: a token string replaces it, `null` clears it, leaving it out keeps it. */
export const PUT: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request);
	let info;
	try {
		info = saveGlobal({ mlApiUrl: b.mlApiUrl, token: b.token, publicUrl: b.publicUrl });
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	const parts = [`ML API ${info.mlApiUrl ?? 'unset'}`, `reachable at ${info.publicUrl ?? 'unset'}`, b.token !== undefined ? (b.token ? 'token changed' : 'token cleared') : null].filter(Boolean);
	audit(locals, 'settings.detection', { detail: parts.join(', ') });
	return json(info);
});
