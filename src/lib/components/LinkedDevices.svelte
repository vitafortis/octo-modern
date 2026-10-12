<script lang="ts">
	import { onMount } from 'svelte';
	import { CircleAlert, LoaderCircle, Settings2, Smartphone, Trash2 } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import type { LinkedDevice } from '#lib/devices.ts';

	/**
	 * The Android app installs linked to this account: each has its own token for progress
	 * notifications and the widget. Shown once there is one (or inside the app).
	 */
	let devices = $state<LinkedDevice[] | null>(null);
	let loadError = $state('');
	let inApp = $state(false);
	let busy = $state<string | null>(null);

	const active = $derived(devices?.filter((d) => !d.revokedAt) ?? []);
	const revoked = $derived(devices?.filter((d) => d.revokedAt) ?? []);

	async function load() {
		try {
			devices = await api.get<LinkedDevice[]>('/api/account/devices');
		} catch (err) {
			loadError = errorMessage(err);
		}
	}

	onMount(() => {
		inApp = /\bOctoModernAndroid\//.test(navigator.userAgent);
		void load();
	});

	async function remove(d: LinkedDevice) {
		if (!d.revokedAt) {
			const ok = await confirmAction({
				title: `Sign out ${d.name}?`,
				body: 'Its progress notifications and widget stop at once. Sign in again in the app to link it again.',
				confirmLabel: 'Sign out device',
				danger: true
			});
			if (!ok) return;
		}
		busy = d.id;
		try {
			await api.del(`/api/account/devices/${d.id}`);
			if (!d.revokedAt) toast('success', 'Device signed out', d.name);
			await load();
		} catch (err) {
			toast('error', 'Couldn’t remove the device', errorMessage(err));
		} finally {
			busy = null;
		}
	}
</script>

{#if loadError}
	<section class="card p-4 sm:p-5">
		<p class="flex items-center gap-1.5 text-xs text-danger"><CircleAlert class="size-3.5 shrink-0" />{loadError}</p>
	</section>
{:else if devices && (devices.length || inApp)}
	<section class="card p-4 sm:p-5" aria-labelledby="devices-h" data-testid="linked-devices">
		<div class="flex flex-wrap items-start gap-3">
			<div class="min-w-0 flex-1">
				<h2 id="devices-h" class="flex items-center gap-2 text-sm font-semibold"><Smartphone class="size-4 text-primary" />Android app</h2>
				<p class="mt-1 text-xs text-muted-foreground">
					Phones signed in to the octo·modern app. Each one shows print progress notifications and widgets with your role and printer access. Signing a device out stops them at once.
				</p>
			</div>
			{#if inApp}
				<a class="btn btn-secondary max-sm:h-11 max-sm:w-full" href="octomodern://settings" data-testid="app-settings"><Settings2 />App settings</a>
			{/if}
		</div>
		{#if active.length || revoked.length}
			<ul class="mt-3 divide-y divide-border rounded-xl border border-border">
				{#each [...active, ...revoked] as d (d.id)}
					<li class="flex items-center gap-3 px-3 py-2.5 sm:px-4" data-device={d.name}>
						<span class="grid size-9 shrink-0 place-items-center rounded-lg {d.revokedAt ? 'bg-surface text-muted-foreground' : 'bg-primary-soft text-primary'}"><Smartphone class="size-4" /></span>
						<div class="min-w-0 flex-1">
							<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] font-medium">
								<span class="truncate">{d.name}</span>
								{#if d.revokedAt}<span class="badge">Signed out</span>{/if}
							</p>
							<p class="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
								<span>Linked {ago(d.createdAt)}</span>
								{#if d.revokedAt}<span>Signed out {ago(d.revokedAt)}</span>{:else if d.lastUsedAt}<span>Last seen {ago(d.lastUsedAt)}</span>{/if}
								<span class="font-mono text-[0.6875rem]">{d.prefix}…</span>
							</p>
						</div>
						<button
							class="btn btn-ghost btn-icon btn-sm hover:text-danger max-sm:size-11"
							title={d.revokedAt ? `Forget ${d.name}` : `Sign out ${d.name}`}
							aria-label={d.revokedAt ? `Forget ${d.name}` : `Sign out ${d.name}`}
							disabled={busy === d.id}
							onclick={() => remove(d)}
						>
							{#if busy === d.id}<LoaderCircle class="animate-spin" />{:else}<Trash2 />{/if}
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-3 text-xs text-muted-foreground">This phone links itself after you sign in; it shows up here then.</p>
		{/if}
	</section>
{/if}
