<script module lang="ts">
	/** The sidebar's power context menu (right-click a printer, or long-press on touch screens). */
	export const powerMenu = $state<{ target: { id: string; name: string; control: boolean } | null; x: number; y: number }>({ target: null, x: 0, y: 0 });
</script>

<script lang="ts">
	import { ExternalLink, Power, PowerOff, Timer } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { clock, keepOn, plugs, pollPower, powerOff, powerOn, tickClock } from '#lib/client/power.svelte.ts';
	import { formatCountdown, formatWatts } from '#lib/power.ts';

	$effect(() => pollPower());
	const t = $derived(powerMenu.target);
	$effect(() => {
		if (t) return tickClock();
	});
	const info = $derived(t ? plugs[t.id] : undefined);
	let el = $state<HTMLElement>();

	const close = () => (powerMenu.target = null);
	async function run(fn: () => Promise<unknown>) {
		close();
		await fn();
	}
	// Keep the menu on screen.
	const pos = $derived({ x: Math.min(powerMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 232), y: Math.min(powerMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 220) });
</script>

<svelte:window onclick={(e) => t && el && !el.contains(e.target as Node) && close()} onkeydown={(e) => e.key === 'Escape' && close()} onblur={close} />

{#if t && info}
	<div bind:this={el} role="menu" aria-label="{t.name} power" class="card fixed z-50 w-56 p-1.5 text-[0.8125rem] shadow-surface-lg" style="left:{pos.x}px; top:{pos.y}px" data-testid="power-menu">
		<p class="truncate px-2.5 pt-1 pb-1.5 text-[0.6875rem] text-muted-foreground">
			{t.name} · {info.reading?.on === true ? 'on' : info.reading?.on === false ? 'off' : 'unknown'}{info.reading?.on && info.reading.powerW != null ? ` · ${formatWatts(info.reading.powerW)}` : ''}
		</p>
		{#if t.control}
			{#if info.reading?.on !== true}<button role="menuitem" class="flex h-9 touch:h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-accent" onclick={() => run(() => powerOn(t.id, t.name))}><Power class="size-4 text-success" />Power on</button>{/if}
			{#if info.reading?.on !== false}<button role="menuitem" class="flex h-9 touch:h-11 w-full items-center gap-2 rounded-lg px-2.5 text-danger hover:bg-danger/10" onclick={() => run(() => powerOff(t.id, t.name))}><PowerOff class="size-4" />Power off</button>{/if}
			{#if info.countdown}<button role="menuitem" class="flex h-9 touch:h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-accent" onclick={() => run(() => keepOn(t.id))}><Timer class="size-4 text-warning" /><span class="flex-1 text-left">Keep on</span><span class="font-mono text-[0.6875rem] text-muted-foreground">{info.countdown.cooling ? 'cooling' : formatCountdown(info.countdown.offAt - clock.now)}</span></button>{/if}
		{/if}
		<button role="menuitem" class="flex h-9 touch:h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-accent" onclick={() => run(() => goto(`/p/${t.id}`))}><ExternalLink class="size-4 text-muted-foreground" />Open printer</button>
	</div>
{/if}
