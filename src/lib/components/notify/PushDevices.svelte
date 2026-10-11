<script lang="ts">
	import { onMount } from 'svelte';
	import { BellOff, BellRing, CircleAlert, Info, LoaderCircle, MonitorSmartphone, Send, Share, Trash2 } from '@lucide/svelte';
	import ActionMenu from '#lib/components/ActionMenu.svelte';
	import { errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { disable, enable, pushApi, support, sync, type Support } from '#lib/client/push.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { listLayout } from '#lib/client/viewport.svelte.ts';
	import type { PushDevice, PushState } from '#lib/push.ts';

	/**
	 * Browser push for the signed-in person: turn it on or off for this device, see and
	 * remove their other devices, send a test. On the Account and Notifications pages.
	 */
	let { admin = false }: { admin?: boolean } = $props();

	let push = $state<PushState | null>(null);
	let can = $state<Support | null>(null);
	let endpoint = $state<string | null>(null);
	let permission = $state<NotificationPermission | null>(null);
	let busy = $state(false);
	let testing = $state<string | null>(null);
	let loadError = $state('');

	const here = $derived(push?.devices.find((d) => d.endpoint === endpoint));

	onMount(async () => {
		can = support();
		permission = 'Notification' in window ? Notification.permission : null;
		try {
			const s = await pushApi.state();
			const r = can.ok ? await sync(s) : { endpoint: null, state: s };
			push = r.state;
			endpoint = r.endpoint;
		} catch (err) {
			loadError = errorMessage(err);
		}
	});

	async function turnOn() {
		if (!push) return;
		busy = true;
		try {
			const r = await enable(push.publicKey);
			push = r.state;
			endpoint = r.device.endpoint;
			toast('success', 'Notifications on for this device', r.device.label);
		} catch (err) {
			toast('error', 'Couldn’t turn notifications on', errorMessage(err));
		} finally {
			permission = 'Notification' in window ? Notification.permission : null;
			busy = false;
		}
	}

	async function turnOff() {
		busy = true;
		try {
			const s = await disable(here);
			if (s) push = s;
			endpoint = null;
			toast('success', 'Notifications off for this device');
		} catch (err) {
			toast('error', 'Couldn’t turn notifications off', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function remove(d: PushDevice) {
		if (d.endpoint === endpoint) return turnOff();
		const ok = await confirmAction({ title: `Remove ${d.label}?`, body: 'It stops getting notifications from octo·modern. You can turn them on again from that device.', confirmLabel: 'Remove', danger: true });
		if (!ok) return;
		try {
			push = (await pushApi.remove(d.id)).state;
			toast('success', 'Device removed', d.label);
		} catch (err) {
			toast('error', 'Couldn’t remove the device', errorMessage(err));
		}
	}

	async function test(d: PushDevice) {
		testing = d.id;
		try {
			const r = await pushApi.test(d.id);
			toast('success', `Test sent to ${d.label}`, `The push service took it in ${r.ms} ms.`);
		} catch (err) {
			toast('error', `The test to ${d.label} didn’t go through`, errorMessage(err));
		} finally {
			testing = null;
			try {
				push = await pushApi.state();
			} catch {}
		}
	}
</script>

<section class="card p-4 sm:p-5" aria-labelledby="push-h" data-testid="push-devices">
	<div class="flex flex-wrap items-start gap-3">
		<div class="min-w-0 flex-1">
			<h2 id="push-h" class="flex items-center gap-2 text-sm font-semibold"><BellRing class="size-4 text-primary" />Browser push</h2>
			<p class="mt-1 text-xs text-muted-foreground">Notifications from octo·modern on this phone or computer, even when it’s closed. Only for printers you have access to.</p>
		</div>
		{#if push && can?.ok}
			{#if here}
				<button class="btn btn-secondary max-sm:w-full max-sm:h-11" disabled={busy} onclick={turnOff} data-testid="push-off">
					{#if busy}<LoaderCircle class="animate-spin" />{:else}<BellOff />{/if}Turn off on this device
				</button>
			{:else if permission !== 'denied'}
				<button class="btn btn-primary max-sm:w-full max-sm:h-11" disabled={busy} onclick={turnOn} data-testid="push-on">
					{#if busy}<LoaderCircle class="animate-spin" />{:else}<BellRing />{/if}Enable notifications on this device
				</button>
			{/if}
		{/if}
	</div>

	{#if loadError}
		<p class="mt-3 flex items-center gap-1.5 text-xs text-danger"><CircleAlert class="size-3.5 shrink-0" />{loadError}</p>
	{:else if !push || !can}
		<div class="grid h-16 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
	{:else}
		{#if !can.ok}
			<p class="mt-3 flex items-start gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-muted-foreground" data-testid="push-unsupported">
				{#if can.reason === 'ios-home'}
					<Share class="mt-0.5 size-3.5 shrink-0" /><span>On iPhone and iPad, add octo·modern to your Home Screen first (Share → <strong class="font-medium text-foreground">Add to Home Screen</strong>), then open it from there and turn notifications on.</span>
				{:else if can.reason === 'insecure'}
					<Info class="mt-0.5 size-3.5 shrink-0" /><span>Browser push needs HTTPS: open octo·modern at its https:// address to turn notifications on for this device.</span>
				{:else}
					<Info class="mt-0.5 size-3.5 shrink-0" /><span>This browser doesn’t support push notifications.</span>
				{/if}
			</p>
		{:else if permission === 'denied' && !here}
			<p class="mt-3 flex items-start gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-muted-foreground"><BellOff class="mt-0.5 size-3.5 shrink-0" /><span>Notifications are blocked for this site. Allow them in the browser’s site settings, then reload.</span></p>
		{/if}

		{#if !push.channelReady}
			<p class="mt-3 flex items-start gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-muted-foreground" data-testid="push-not-ready">
				<Info class="mt-0.5 size-3.5 shrink-0" />
				<span>{admin ? 'No rule sends to browser push yet: add a Browser push channel and a rule for it under Channels and Rules.' : 'No notification rule sends to browser push yet; an admin sets that up under Notifications.'}</span>
			</p>
		{/if}

		{#if push.devices.length}
			<ul class="mt-3 divide-y divide-border rounded-xl border border-border" data-testid="push-device-list">
				{#each push.devices as d (d.id)}
					<li class="flex items-center gap-3 px-3 py-2.5 sm:px-4" data-device={d.label}>
						<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><MonitorSmartphone class="size-4" /></span>
						<div class="min-w-0 flex-1">
							<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] font-medium">
								<span class="truncate">{d.label}</span>
								{#if d.endpoint === endpoint}<span class="badge badge-success" data-testid="push-this-device">This device</span>{/if}
							</p>
							<p class="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
								<span>Added {ago(d.createdAt)}</span>
								{#if d.lastError}
									<span class="flex min-w-0 items-center gap-1 text-danger" title={d.lastError}><CircleAlert class="size-3.5 shrink-0" /><span class="truncate">{d.lastError}</span></span>
								{:else if d.lastSentAt}
									<span>Last sent {ago(d.lastSentAt)}</span>
								{/if}
							</p>
						</div>
						{#if listLayout.current}
							<ActionMenu
								title={d.label}
								description={d.endpoint === endpoint ? 'This device' : undefined}
								actions={[
									{ label: 'Send test', icon: Send, disabled: !!testing, onclick: () => test(d) },
									{ label: d.endpoint === endpoint ? 'Turn off on this device' : 'Remove', icon: Trash2, danger: true, onclick: () => remove(d) }
								]}
							/>
						{:else}
							<button class="btn btn-secondary btn-sm" disabled={!!testing} onclick={() => test(d)}>
								{#if testing === d.id}<LoaderCircle class="animate-spin" />{:else}<Send />{/if}Send test
							</button>
							<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Remove {d.label}" aria-label="Remove {d.label}" onclick={() => remove(d)}><Trash2 /></button>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-3 text-xs text-muted-foreground">No devices yet.</p>
		{/if}

		{#if admin && push.counts}
			<p class="mt-3 text-[0.6875rem] text-muted-foreground" data-testid="push-counts">
				Everyone: {push.counts.devices} device{push.counts.devices === 1 ? '' : 's'} of {push.counts.users} {push.counts.users === 1 ? 'person' : 'people'} subscribed.
			</p>
		{/if}
	{/if}
</section>
