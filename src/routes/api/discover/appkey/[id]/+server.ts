import { json } from '@sveltejs/kit';
import { handler, NotFound } from '#lib/server/http.ts';
import { appKeys } from '#lib/server/discovery/appkeys.ts';
import type { RequestHandler } from './$types';

/** The request's state: pending, approved, denied, expired or error (never the key). */
export const GET: RequestHandler = handler(({ params }) => {
	const s = appKeys.status(params.id);
	if (!s) throw new NotFound('This key request is gone; start again');
	return json(s);
});

export const DELETE: RequestHandler = handler(({ params }) => json({ ok: appKeys.cancel(params.id) }));
