import { json } from '@sveltejs/kit';
import { BadRequest, NotFound, handler } from '#lib/server/http.ts';
import { deleteDevice, getDevice, revokeDevice } from '#lib/server/devices.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

/**
 * Removes one of your linked devices: an active one is revoked (its token stops working at
 * once), a revoked one is forgotten.
 */
export const DELETE: RequestHandler = handler(({ params, locals }) => {
	if (locals.device) throw new BadRequest('Use /api/account/devices/current');
	const user = locals.user;
	if (locals.auth !== 'authenticated' || !user) throw new BadRequest('Sign in to manage your devices');
	const d = getDevice(params.id);
	if (!d || d.userId !== user.id) throw new NotFound('Device not found');
	if (d.revokedAt) {
		deleteDevice(user.id, d.id);
		return json({ ok: true, deleted: true });
	}
	revokeDevice(user.id, d.id);
	audit(locals, 'device.revoke', { detail: d.name });
	return json({ ok: true, revoked: true });
});
