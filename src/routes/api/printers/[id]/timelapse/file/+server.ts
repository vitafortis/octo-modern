import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, viewTarget } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { fetchTimelapseFile, forwardHeaders, PASS_STATUSES, responseHeaders, validTimelapseName } from '#lib/server/octoprint/timelapse.ts';
import type { RequestHandler } from './$types';

function nameParam(url: URL): string {
	const name = url.searchParams.get('name');
	if (!validTimelapseName(name)) throw new BadRequest('"name" must be a file name from the timelapse list');
	return name;
}

/**
 * A rendered timelapse (or its thumbnail), `?name=<file>`, relayed from OctoPrint with
 * Range requests passed through, so the browser's player can seek. `&download=1`
 * makes it an attachment.
 */
export const GET: RequestHandler = handler(async ({ params, locals, url, request }) => {
	const { client } = viewTarget(locals.user, params.id);
	const name = nameParam(url);
	const res = await fetchTimelapseFile(client, name, forwardHeaders(request.headers), request.signal);
	if (!PASS_STATUSES.has(res.status)) {
		await res.body?.cancel();
		if (res.status === 404) return json({ message: 'That timelapse no longer exists' }, { status: 404 });
		return json({ message: `OctoPrint answered HTTP ${res.status}` }, { status: 502 });
	}
	const headers = responseHeaders(res.headers, name, url.searchParams.get('download') === '1');
	return new Response(res.status === 304 ? null : res.body, { status: res.status, headers });
});

/** Deletes a rendered timelapse: `?name=<file>&confirm=1`. */
export const DELETE: RequestHandler = handler(async ({ params, locals, url }) => {
	const { printer, client } = controlTarget(locals.user, params.id);
	const name = nameParam(url);
	if (url.searchParams.get('confirm') !== '1') return confirmRequired(`Deleting ${name} can’t be undone. Add confirm=1 to delete it.`);
	await client.json('DELETE', `/api/timelapse/${encodeURIComponent(name)}`);
	audit(locals, 'timelapse.delete', { printer, detail: name });
	return json({ ok: true });
});
