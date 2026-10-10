import { redirect } from '@sveltejs/kit';
import { localLoginDisabled, ssoConfig } from '#lib/server/sso.ts';
import { accessSettings } from '#lib/server/auth.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.auth === 'setup') redirect(303, '/setup');
	if (locals.auth === 'authenticated' || locals.auth === 'disabled') redirect(303, '/');
	return {
		sso: ssoConfig() ? { name: ssoConfig()!.name } : null,
		localLogin: !localLoginDisabled(),
		error: url.searchParams.get('error') ?? '',
		/** Sign-in is optional here; visitors can go back to watching as a guest. */
		guest: locals.auth === 'open' ? accessSettings().guestRole : null
	};
};
