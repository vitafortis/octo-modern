<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { KeyRound, LoaderCircle, Lock, Save, UserRound } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import PushDevices from '#lib/components/notify/PushDevices.svelte';
	import LinkedDevices from '#lib/components/LinkedDevices.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Seed the form once; it shouldn't reset when page data refreshes.
	let name = $state(untrack(() => data.user.name ?? ''));
	let email = $state(untrack(() => data.user.email));
	let currentPassword = $state('');
	let newPassword = $state('');
	let repeat = $state('');
	let busy = $state(false);
	let error = $state('');

	async function saveProfile(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (newPassword && newPassword !== repeat) {
			error = 'New passwords do not match';
			return;
		}
		busy = true;
		try {
			await api.put('/api/account', {
				name,
				email: data.user.sso ? undefined : email,
				currentPassword: currentPassword || undefined,
				newPassword: newPassword || undefined
			});
			currentPassword = newPassword = repeat = '';
			await invalidateAll();
			toast('success', 'Account updated');
		} catch (err) {
			error = errorMessage(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>My account · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="My account" description="Your profile, how you sign in, and notifications on your devices." />
	<form class="max-w-2xl space-y-5 page-x pb-5" onsubmit={saveProfile}>
		<section class="card p-5">
			<h2 class="flex items-center gap-2 text-sm font-semibold"><UserRound class="size-4 text-primary" />Profile</h2>
			<div class="mt-4 grid gap-3 sm:grid-cols-2">
				<div>
					<label class="label" for="p-name">Name</label>
					<input id="p-name" class="input" autocomplete="name" bind:value={name} />
				</div>
				<div>
					<label class="label" for="p-email">Email</label>
					<input id="p-email" class="input" type="email" autocomplete="email" disabled={data.user.sso} bind:value={email} />
					{#if data.user.sso}<p class="mt-1 text-[0.6875rem] text-muted-foreground">Managed by your identity provider.</p>{/if}
				</div>
			</div>
			<div class="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
				Role <span class="badge capitalize">{data.user.role}</span>
				<span class="ml-2">Sign-in</span>
				{#if data.user.sso}<span class="badge badge-primary"><KeyRound />SSO</span>{/if}
				{#if data.user.hasPassword}<span class="badge"><Lock />Password</span>{/if}
			</div>
		</section>

		<section class="card p-5">
			<h2 class="flex items-center gap-2 text-sm font-semibold"><Lock class="size-4 text-primary" />{data.user.hasPassword ? 'Change password' : 'Set a password'}</h2>
			{#if !data.user.hasPassword}
				<p class="mt-1 text-xs text-muted-foreground">Optional — lets you sign in without single sign-on.</p>
			{/if}
			<div class="mt-4 grid gap-3 sm:grid-cols-3">
				{#if data.user.hasPassword}
					<input class="input" type="password" placeholder="Current password" autocomplete="current-password" bind:value={currentPassword} />
				{/if}
				<input class="input" type="password" placeholder="New password" autocomplete="new-password" bind:value={newPassword} />
				<input class="input" type="password" placeholder="Repeat new password" autocomplete="new-password" bind:value={repeat} />
			</div>
		</section>

		{#if error}<p class="text-xs text-danger">{error}</p>{/if}
		<div class="flex justify-end">
			<button class="btn btn-primary" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<Save />{/if}Save</button>
		</div>
	</form>
	<div class="max-w-2xl space-y-5 page-x pb-10">
		<PushDevices admin={data.user.role === 'admin'} />
		<LinkedDevices />
	</div>
</div>
