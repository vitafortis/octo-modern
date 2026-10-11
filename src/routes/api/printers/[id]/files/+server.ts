import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, viewTarget } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

/** Every file and folder on the printer (OctoPrint: local and SD card; Klipper: the gcodes folder), as a tree. */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const { backend } = viewTarget(locals.user, params.id);
	return json(await backend.files(), { headers: { 'cache-control': 'no-store' } });
});

/** Deletes a file or folder: `?origin=local&path=a/b.gcode&confirm=1`. OctoPrint refuses (409) while it's in use. */
export const DELETE: RequestHandler = handler(async ({ params, locals, url }) => {
	const { printer, backend } = controlTarget(locals.user, params.id);
	const origin = url.searchParams.get('origin') === 'sdcard' ? 'sdcard' : 'local';
	const path = url.searchParams.get('path')?.replace(/^\/+/, '') ?? '';
	if (!path || path.split('/').includes('..')) throw new BadRequest('"path" is required');
	if (url.searchParams.get('confirm') !== '1') return confirmRequired(`Deleting ${path} can’t be undone. Add confirm=1 to delete it.`);
	await backend.deleteFile(origin, path);
	audit(locals, 'file.delete', { printer, detail: `${origin === 'sdcard' ? 'SD: ' : ''}${path}` });
	return json({ ok: true });
});
