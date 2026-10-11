<script lang="ts">
	import { LoaderCircle, Power, PowerOff } from '@lucide/svelte';
	import { plugs, pollPower, powerOff, powerOn } from '#lib/client/power.svelte.ts';

	/** Power on / off for a printer with a smart plug (nothing without one). */
	let { printerId, name, compact = false }: { printerId: string; name: string; compact?: boolean } = $props();

	$effect(() => pollPower());
	const info = $derived(plugs[printerId]);
	const on = $derived(info?.reading?.on ?? null);
	let busy = $state(false);

	async function run(fn: typeof powerOn) {
		busy = true;
		await fn(printerId, name);
		busy = false;
	}
</script>

{#if info}
	{#if on !== true}
		<button class="btn btn-primary btn-sm" disabled={busy || info.busy} onclick={() => run(powerOn)} title="Switch {name}’s smart plug on" data-testid="power-on">
			{#if busy}<LoaderCircle class="animate-spin" />{:else}<Power />{/if}{compact ? 'On' : 'Power on'}
		</button>
	{/if}
	{#if on !== false}
		<button
			class="btn btn-secondary btn-sm border-danger/40 text-danger hover:border-danger hover:bg-danger/10 hover:text-danger"
			disabled={busy || info.busy}
			onclick={() => run(powerOff)}
			title="Switch {name}’s smart plug off"
			data-testid="power-off"
		>
			{#if busy}<LoaderCircle class="animate-spin" />{:else}<PowerOff />{/if}{compact ? 'Off' : 'Power off'}
		</button>
	{/if}
{/if}
