<script lang="ts">
	import { Thermometer, Timer } from '@lucide/svelte';
	import { clock, countdownText, keepOn, tickClock } from '#lib/client/power.svelte.ts';
	import type { PowerInfo } from '#lib/power.ts';

	/** The auto power-off countdown after a print, with "Keep on". */
	let { info, canControl, compact = false }: { info: PowerInfo; canControl: boolean; compact?: boolean } = $props();

	$effect(() => tickClock());
	const c = $derived(info.countdown);
	const total = $derived(c ? Math.max(1, c.offAt - c.since) : 1);
	const pct = $derived(c ? Math.min(100, Math.max(0, ((clock.now - c.since) / total) * 100)) : 0);
	let busy = $state(false);
</script>

{#if c}
	<div class="rounded-lg border border-warning/30 bg-warning/5 {compact ? 'px-2.5 py-1.5' : 'p-3'}" data-testid="auto-off">
		<div class="flex items-center gap-2">
			{#if c.cooling}<Thermometer class="size-3.5 shrink-0 text-warning" />{:else}<Timer class="size-3.5 shrink-0 text-warning" />{/if}
			<div class="min-w-0 flex-1">
				{#if !compact}<p class="text-[11px] font-medium text-muted-foreground uppercase">Auto power-off</p>{/if}
				<p class="truncate font-mono text-[12px] tabular-nums" data-testid="auto-off-text">{countdownText(info, clock.now)}</p>
			</div>
			{#if canControl}
				<button
					class="btn btn-secondary btn-sm shrink-0 touch:h-11"
					disabled={busy}
					onclick={async (e) => {
						e.preventDefault();
						busy = true;
						await keepOn(info.printerId);
						busy = false;
					}}>Keep on</button
				>
			{/if}
		</div>
		{#if !compact}
			<div class="mt-2 h-1 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-warning transition-[width] duration-1000" style="width:{pct}%"></div></div>
		{/if}
	</div>
{/if}
