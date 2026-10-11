/** Shared bits of the power API routes. */
import { json } from '@sveltejs/kit';
import { BadRequest, Forbidden, handler } from '../http.ts';
import { PlugConfigError } from './config.ts';
import { PlugError } from './http.ts';
import type { User } from '#lib/types.ts';

/** `handler`, plus plug errors as 502 `{ message, code, hint }` and invalid setups as 400. */
export function powerHandler<E>(fn: (event: E) => Promise<Response> | Response) {
	return handler(async (event: E) => {
		try {
			return await fn(event);
		} catch (err) {
			if (err instanceof PlugConfigError) throw new BadRequest(err.message);
			if (err instanceof PlugError) return json({ message: err.message, code: err.code, hint: err.hint }, { status: 502 });
			throw err;
		}
	});
}

export function requireAdmin(user: User | null) {
	if (user?.role !== 'admin') throw new Forbidden('Admins only');
}
