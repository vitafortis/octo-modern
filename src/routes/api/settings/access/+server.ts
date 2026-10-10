import { json } from '@sveltejs/kit';
import { accessSettings, saveAccessSettings } from '#lib/server/auth.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

/** Whether visitors must sign in to octo·modern (admins only, via access.ts). */
export const GET: RequestHandler = () => json(accessSettings());

export const PUT: RequestHandler = handler(async ({ request, locals }) => {
	const body = (await request.json()) as { requireSignIn?: unknown; guestRole?: unknown };
	if (typeof body.requireSignIn !== 'boolean') throw new BadRequest('"requireSignIn" must be true or false');
	if (body.guestRole !== 'viewer' && body.guestRole !== 'operator') throw new BadRequest('"guestRole" must be viewer or operator');
	const next = { requireSignIn: body.requireSignIn, guestRole: body.guestRole } as const;
	saveAccessSettings(next);
	audit(locals, 'settings.access', {
		detail: next.requireSignIn ? 'sign-in required' : `sign-in optional; guests are ${next.guestRole === 'operator' ? 'operators' : 'viewers'}`
	});
	return json(next);
});
