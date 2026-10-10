import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { scanMdns } from '#lib/server/discovery/lan.ts';
import { prepare } from '#lib/server/discovery/index.ts';
import type { RequestHandler } from './$types';

/** Browses mDNS for `_octoprint._tcp` for a few seconds (admins). */
export const POST: RequestHandler = handler(async () => {
	const scan = await scanMdns();
	prepare(scan.candidates);
	return json(scan);
});
