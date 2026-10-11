<script lang="ts">
	import { Power, PowerOff } from '@lucide/svelte';
	import AutoOffNotice from './AutoOffNotice.svelte';
	import PowerButtons from './PowerButtons.svelte';
	import { plugs, pollPower } from '#lib/client/power.svelte.ts';
	import { formatWatts } from '#lib/power.ts';
	import type { Printer } from '#lib/types.ts';

	/** The overview card's power row: plug state, draw, countdown and on/off. */
	let { printer }: { printer: Printer } = $props();

	$effect(() => pollPower());
	const info = $derived(plugs[printer.id]);
	const on = $derived(info?.reading?.on ?? null);
	const control = $derived(!!printer.access?.control);
</script>

{#if info}
	<div class="relative space-y-2 border-t border-border bg-surface px-4 py-2" data-testid="power-strip">
		{#if info.countdown}<AutoOffNotice {info} canControl={control} compact />{/if}
		<div class="flex min-h-9 items-center gap-2 text-xs">
			{#if on === false}<PowerOff class="size-3.5 text-muted-foreground" />{:else}<Power class="size-3.5 {on ? 'text-success' : 'text-warning'}" />{/if}
			<span class="text-muted-foreground">{on === true ? 'Plug on' : on === false ? 'Plug off' : 'Plug state unknown'}</span>
			{#if on && info.reading?.powerW != null}<span class="font-mono tabular-nums">{formatWatts(info.reading.powerW)}</span>{/if}
			{#if control}<div class="ml-auto flex gap-1.5"><PowerButtons printerId={printer.id} name={printer.name} compact /></div>{/if}
		</div>
	</div>
{/if}
