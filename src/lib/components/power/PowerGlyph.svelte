<script lang="ts">
	import { PowerOff, Timer } from '@lucide/svelte';
	import { plugs } from '#lib/client/power.svelte.ts';

	/** A small sidebar hint: the plug is off, or an auto power-off is counting down. */
	let { printerId }: { printerId: string } = $props();
	const info = $derived(plugs[printerId]);
</script>

{#if info?.countdown}
	<span title="Auto power-off counting down" class="shrink-0"><Timer class="size-3 text-warning" /></span>
{:else if info?.reading?.on === false}
	<span title="Smart plug off" class="shrink-0" data-testid="glyph-off"><PowerOff class="size-3 text-muted-foreground/70" /></span>
{/if}
