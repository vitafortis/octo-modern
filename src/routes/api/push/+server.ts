import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { pushState, pushUser } from '#lib/server/push/api.ts';
import type { RequestHandler } from './$types';

/** Browser push for the signed-in person: the VAPID public key and their devices (admins also get counts). */
export const GET: RequestHandler = handler(({ locals }) => json(pushState(pushUser(locals))));
