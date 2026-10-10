import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { validTimelapseName } from '#lib/server/octoprint/timelapse.ts';
import type { RequestHandler } from './$types';

/** Renders an unrendered timelapse (the frames of a print): `{ name }`. */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, client } = controlTarget(locals.user, params.id);
	const b = await body(request);
	if (!validTimelapseName(b.name)) throw new BadRequest('"name" must be a name from the unrendered list');
	await client.post(`/api/timelapse/unrendered/${encodeURIComponent(b.name)}`, { command: 'render' });
	audit(locals, 'timelapse.render', { printer, detail: b.name });
	return json({ ok: true });
});

/** Deletes an unrendered timelapse's frames: `?name=<name>&confirm=1`. */
export const DELETE: RequestHandler = handler(async ({ params, locals, url }) => {
	const { printer, client } = controlTarget(locals.user, params.id);
	const name = url.searchParams.get('name');
	if (!validTimelapseName(name)) throw new BadRequest('"name" must be a name from the unrendered list');
	if (url.searchParams.get('confirm') !== '1') return confirmRequired(`Deleting the frames of ${name} can’t be undone. Add confirm=1 to delete them.`);
	await client.json('DELETE', `/api/timelapse/unrendered/${encodeURIComponent(name)}`);
	audit(locals, 'timelapse.delete_unrendered', { printer, detail: name });
	return json({ ok: true });
});
