import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { listSends } from '#lib/server/library/send.ts';
import type { RequestHandler } from './$types';

/** Your recent and running transfers (admins: everyone's). */
export const GET: RequestHandler = handler(async ({ locals }) => json(listSends(locals.user), { headers: { 'cache-control': 'no-store' } }));
