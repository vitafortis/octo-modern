import { json } from '@sveltejs/kit';
import { hashPassword, verifyPassword } from '#lib/server/crypto.ts';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { findUserByEmail, getPasswordHash, updateUser } from '#lib/server/store.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lets the signed-in user change their own name, email and password. */
export const PUT: RequestHandler = handler(async ({ request, locals }) => {
	const user = locals.user;
	if (!user || user.id === 'open') throw new BadRequest('Accounts are disabled (OCM_AUTH=disabled)');
	const b = await body(request);
	const patch: Parameters<typeof updateUser>[1] = {};

	if (typeof b.name === 'string') patch.name = b.name.trim() || null;

	if (typeof b.email === 'string' && b.email.trim() !== user.email) {
		const email = b.email.trim();
		if (!EMAIL.test(email)) throw new BadRequest('Enter a valid email address');
		const taken = findUserByEmail(email);
		if (taken && taken.id !== user.id) throw new BadRequest(`${email} is already used by another account`);
		// SSO accounts are matched by email at the provider; changing it here would break that link's meaning.
		if (user.sso) throw new BadRequest('Your email comes from single sign-on and can’t be changed here');
		patch.email = email;
	}

	if (typeof b.newPassword === 'string' && b.newPassword) {
		if (b.newPassword.length < 8) throw new BadRequest('Use at least 8 characters for the new password');
		const current = getPasswordHash(user.id);
		if (current && !(typeof b.currentPassword === 'string' && verifyPassword(b.currentPassword, current))) {
			throw new BadRequest('Current password is incorrect');
		}
		patch.passwordHash = hashPassword(b.newPassword);
	}

	const updated = updateUser(user.id, patch)!;
	if (patch.passwordHash) audit(locals, 'account.password');
	return json({ email: updated.email, name: updated.name });
});
