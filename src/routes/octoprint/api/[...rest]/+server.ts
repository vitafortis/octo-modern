import { json } from '@sveltejs/kit';
import { COMPAT_PREFIX, handleUpload, opError, readOnly } from '#lib/server/octoprint-compat.ts';
import type { RequestHandler } from './$types';

/**
 * The OctoPrint-compatible API for slicers (see octoprint-compat.ts). hooks.server.ts
 * has already checked the upload key and put it in `locals.apiToken`.
 */
export const GET: RequestHandler = ({ params, locals }) => {
	const body = readOnly(params.rest.replace(/\/+$/, ''), locals.apiToken!);
	if (body == null) return params.rest.startsWith('files/') ? opError(404, 'File not found') : opError(404, 'Not found');
	return json(body);
};

export const POST: RequestHandler = ({ params, locals, request, url }) => {
	const path = params.rest.replace(/\/+$/, '');
	if (path === 'files/local') return handleUpload(request, url, locals.apiToken!, { ip: locals.ip, base: `${locals.origin}${COMPAT_PREFIX}` });
	if (path === 'files/sdcard') return opError(409, 'octo·modern doesn’t take SD card uploads; upload to local storage');
	if (path === 'login') return json({ name: locals.apiToken!.name, active: true, admin: false, groups: [], permissions: [] });
	return opError(404, 'Not found');
};

export const fallback: RequestHandler = () => opError(405, 'Method not allowed');
