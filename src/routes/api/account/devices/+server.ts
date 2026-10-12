import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { createDevice, listDevices, parseDeviceInput, publicDevice } from '#lib/server/devices.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

function signedInUser(locals: App.Locals) {
	if (locals.device) throw new BadRequest('Device tokens can’t link other devices');
	if (locals.auth !== 'authenticated' || !locals.user) throw new BadRequest('Sign in to link this device');
	return locals.user;
}

/** The signed-in user's linked devices (the Android app). */
export const GET: RequestHandler = handler(({ locals }) => {
	const user = signedInUser(locals);
	return json(listDevices(user.id).map((d) => publicDevice(d)), { headers: { 'cache-control': 'no-store' } });
});

/**
 * Links a device to the signed-in session's account: `{ name, platform: 'android' }`.
 * Answers `{ token, device }`; the token (`ocd_…`) is shown this once. The Android app
 * calls this with the WebView's session cookie right after you sign in.
 */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const user = signedInUser(locals);
	const input = parseDeviceInput(await body(request));
	const { token, device } = createDevice(user, input);
	audit(locals, 'device.link', { detail: input.name });
	return json({ token, device: publicDevice(device) }, { status: 201, headers: { 'cache-control': 'no-store' } });
});
