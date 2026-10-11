import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { controlTarget } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { validFolderName } from '#lib/server/octoprint/files.ts';
import type { RequestHandler } from './$types';

/** Creates a folder in local storage: `{ name, parent }`. */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, backend } = controlTarget(locals.user, params.id);
	const b = await body(request);
	const name = typeof b.name === 'string' ? b.name.trim() : '';
	const parent = typeof b.parent === 'string' ? b.parent.replace(/^\/+|\/+$/g, '') : '';
	if (!validFolderName(name)) throw new BadRequest('Enter a folder name without slashes');
	if (parent.split('/').includes('..')) throw new BadRequest('Bad parent folder');
	await backend.createFolder(name, parent);
	audit(locals, 'file.folder', { printer, detail: parent ? `${parent}/${name}` : name });
	return json({ ok: true }, { status: 201 });
});
