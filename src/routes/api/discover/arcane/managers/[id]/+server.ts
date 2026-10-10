import { json } from '@sveltejs/kit';
import { handler, NotFound } from '#lib/server/http.ts';
import { removeArcane } from '#lib/server/discovery/config.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	if (!removeArcane(params.id)) throw new NotFound('Not connected');
	audit(locals, 'discovery.arcane', { detail: 'disconnected an Arcane instance' });
	return json({ ok: true });
});
