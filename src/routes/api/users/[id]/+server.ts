import { json } from '@sveltejs/kit';
import { hashPassword } from '#lib/server/crypto.ts';
import { BadRequest, body, handler, NotFound } from '#lib/server/http.ts';
import { countAdmins, deleteUser, getUser, updateUser } from '#lib/server/store.ts';
import { audit } from '#lib/server/permissions.ts';
import { isRole } from '#lib/types.ts';
import type { RequestHandler } from './$types';

function guardLastAdmin(id: string, losingAdmin: boolean) {
	const user = getUser(id);
	if (!user) throw new NotFound('User not found');
	if (losingAdmin && user.role === 'admin' && !user.disabled && countAdmins() <= 1) {
		throw new BadRequest('This is the last admin. Promote someone else first.');
	}
	return user;
}

export const PATCH: RequestHandler = handler(async ({ params, request, locals }) => {
	const b = await body(request);
	const patch: Parameters<typeof updateUser>[1] = {};
	if (b.role !== undefined) {
		if (!isRole(b.role)) throw new BadRequest('"role" must be admin, operator or viewer');
		patch.role = b.role;
	}
	if (typeof b.disabled === 'boolean') patch.disabled = b.disabled;
	if (typeof b.name === 'string') patch.name = b.name.trim() || null;
	if (b.password !== undefined) {
		if (b.password === null || b.password === '') patch.passwordHash = null;
		else if (typeof b.password === 'string' && b.password.length >= 8) patch.passwordHash = hashPassword(b.password);
		else throw new BadRequest('Passwords need at least 8 characters');
	}
	const demoting = patch.role !== undefined && patch.role !== 'admin';
	if (params.id === locals.user?.id && (patch.disabled || demoting)) throw new BadRequest("You can't demote or disable yourself");
	const before = guardLastAdmin(params.id, demoting || patch.disabled === true);
	const updated = updateUser(params.id, patch);
	const changes = [
		patch.role && patch.role !== before.role && `role ${patch.role}`,
		patch.disabled !== undefined && patch.disabled !== before.disabled && (patch.disabled ? 'disabled' : 'enabled'),
		patch.passwordHash !== undefined && (patch.passwordHash ? 'password set' : 'password removed'),
		patch.name !== undefined && patch.name !== before.name && 'name changed'
	].filter(Boolean);
	if (changes.length) audit(locals, 'user.update', { detail: `${before.email}: ${changes.join(', ')}` });
	return json(updated);
});

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	if (params.id === locals.user?.id) throw new BadRequest("You can't delete yourself");
	const user = guardLastAdmin(params.id, true);
	deleteUser(params.id);
	audit(locals, 'user.delete', { detail: user.email });
	return json({ ok: true });
});
