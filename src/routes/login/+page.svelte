<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const next = $derived.by(() => {
		const n = page.url.searchParams.get('next');
		return n?.startsWith('/') && !n.startsWith('//') ? n : '/';
	});

	async function login(email: string, password: string) {
		try {
			await api.post('/api/auth/login', { email, password });
			await invalidateAll();
			goto(next);
		} catch (err) {
			return errorMessage(err);
		}
	}
</script>

<svelte:head><title>Sign in · octo·modern</title></svelte:head>

<AuthCard
	title="Sign in to octo·modern"
	subtitle="Use your octo·modern account, not your OctoPrint login. Your printers stay connected either way."
	cta="Sign in"
	showForm={data.localLogin}
	sso={data.sso ? { name: data.sso.name, href: `/auth/oidc/start?next=${encodeURIComponent(next)}` } : null}
	error={data.error}
	hint={data.guest ? `Or <a class="text-primary hover:underline" href="/">continue as a guest</a> (${data.guest === 'operator' ? 'can control printers' : 'watch only'}).` : undefined}
	onsubmit={login}
/>

