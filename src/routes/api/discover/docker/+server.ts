import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { scanDocker } from '#lib/server/discovery/docker.ts';
import { prepare } from '#lib/server/discovery/index.ts';
import type { RequestHandler } from './$types';

/** OctoPrint containers on every configured Docker endpoint (admins). */
export const GET: RequestHandler = handler(async () => {
	const scans = await scanDocker();
	prepare(scans.flatMap((s) => s.candidates));
	return json(scans);
});
