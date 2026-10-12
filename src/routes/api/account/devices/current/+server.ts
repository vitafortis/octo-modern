import { json } from '@sveltejs/kit';
import { Forbidden, handler } from '#lib/server/http.ts';
import { getDevice, publicDevice, revokeDevice } from '#lib/server/devices.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

function current(locals: App.Locals) {
	if (!locals.device || !locals.user) throw new Forbidden('Only a device token can use this');
	return { device: getDevice(locals.device.id)!, user: locals.user };
}

/** The app checks its token: who it acts as, and this device's entry. */
export const GET: RequestHandler = handler(({ locals }) => {
	const { device, user } = current(locals);
	return json({ device: publicDevice(device, device.id), user: { name: user.name, email: user.email, role: user.role } }, { headers: { 'cache-control': 'no-store' } });
});

/** The app signs out: its own token is revoked. */
export const DELETE: RequestHandler = handler(({ locals }) => {
	const { device, user } = current(locals);
	revokeDevice(user.id, device.id);
	audit(locals, 'device.revoke', { detail: `${device.name} (signed out in the app)` });
	return json({ ok: true });
});
