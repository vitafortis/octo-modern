<script lang="ts">
	import { CircleAlert, LoaderCircle, Plug, PlugZap, Settings2 } from '@lucide/svelte';
	import AutoOffNotice from './AutoOffNotice.svelte';
	import PowerButtons from './PowerButtons.svelte';
	import PowerConfigDialog from './PowerConfigDialog.svelte';
	import { plugs, plugsLoaded, pollPower } from '#lib/client/power.svelte.ts';
	import { ago } from '#lib/client/format.ts';
	import { isAdmin } from '#lib/client/state.svelte.ts';
	import { formatEnergy, formatWatts, PLUG_LABEL } from '#lib/power.ts';
	import type { Printer } from '#lib/types.ts';

	/** The printer's smart plug on the dashboard: state, draw, auto power-off countdown, and setup for admins. */
	let { printer, canControl }: { printer: Printer; canControl: boolean } = $props();

	$effect(() => pollPower());
	const info = $derived(plugs[printer.id]);
	const on = $derived(info?.reading?.on ?? null);
	let configOpen = $state(false);
	const s = $derived(info?.settings);
</script>

{#if info}
	<section class="card p-4 text-[0.8125rem]" data-testid="power-card">
		<div class="flex items-center gap-2">
			<h2 class="flex items-center gap-2 text-sm font-semibold"><PlugZap class="size-4 text-primary" />Power</h2>
			{#if on === true}<span class="badge badge-success" data-testid="plug-state">On</span>{:else if on === false}<span class="badge" data-testid="plug-state">Off</span>{:else}<span class="badge badge-warning" data-testid="plug-state">Unknown</span>{/if}
			{#if isAdmin()}<button class="btn btn-ghost btn-icon btn-sm ml-auto" title="Smart plug settings" aria-label="Smart plug settings" onclick={() => (configOpen = true)}><Settings2 /></button>{/if}
		</div>
		<dl class="mt-3 space-y-2">
			<div class="flex justify-between gap-3"><dt class="text-muted-foreground">Plug</dt><dd class="truncate text-xs">{info.label ?? PLUG_LABEL[info.kind]}{info.label ? ` · ${PLUG_LABEL[info.kind]}` : ''}</dd></div>
			{#if info.reading?.powerW != null}
				<div class="flex justify-between gap-3"><dt class="text-muted-foreground">Drawing</dt><dd class="font-mono text-xs tabular-nums" data-testid="plug-watts">{formatWatts(info.reading.powerW)}</dd></div>
			{/if}
			{#if info.reading?.energyWh != null}
				<div class="flex justify-between gap-3"><dt class="text-muted-foreground">Energy (meter)</dt><dd class="font-mono text-xs tabular-nums">{formatEnergy(info.reading.energyWh)}</dd></div>
			{/if}
			<div class="flex justify-between gap-3"><dt class="text-muted-foreground">Read</dt><dd class="text-xs">{info.readAt ? ago(new Date(info.readAt).toISOString()) : 'never'}</dd></div>
		</dl>
		{#if info.error}
			<p class="mt-3 flex items-start gap-1.5 text-xs text-danger"><CircleAlert class="mt-px size-3.5 shrink-0" />{info.error}</p>
		{/if}
		{#if info.connect && info.connect.phase !== 'connected' && on !== false}
			<p class="mt-3 flex items-center gap-1.5 text-xs {info.connect.phase === 'failed' ? 'text-warning' : 'text-muted-foreground'}" data-testid="power-connect">
				{#if info.connect.phase !== 'failed'}<LoaderCircle class="size-3.5 animate-spin" />{:else}<CircleAlert class="size-3.5" />{/if}
				{info.connect.phase === 'failed' ? info.connect.message : `Connecting the printer${info.connect.attempt ? ` (attempt ${info.connect.attempt})` : ''}…`}
			</p>
		{/if}
		{#if info.countdown}<div class="mt-3"><AutoOffNotice {info} {canControl} /></div>{/if}
		{#if s}
			<p class="mt-3 text-[0.6875rem] text-muted-foreground">
				{s.autoOff.enabled ? `Auto power-off ${s.autoOff.idleMinutes} min after a print, below ${s.autoOff.hotendC} °C` : 'No auto power-off'} · auto-connect {s.autoConnect ? 'on' : 'off'}{s.autoOn ? ' · powers on for new prints' : ''}
			</p>
		{/if}
		{#if canControl}<div class="mt-3 flex flex-wrap gap-2"><PowerButtons printerId={printer.id} name={printer.name} /></div>{/if}
	</section>
{:else if isAdmin() && plugsLoaded.value}
	<section class="card p-4 text-[0.8125rem]">
		<h2 class="flex items-center gap-2 text-sm font-semibold"><Plug class="size-4 text-primary" />Power</h2>
		<p class="mt-2 text-xs text-muted-foreground">Switch this printer with a smart plug (Shelly, Tasmota, Home Assistant or any HTTP switch), and turn it off by itself after a print.</p>
		<button class="btn btn-secondary btn-sm mt-3" onclick={() => (configOpen = true)} data-testid="power-setup"><PlugZap />Set up a smart plug</button>
	</section>
{/if}

{#if isAdmin()}<PowerConfigDialog bind:open={configOpen} {printer} />{/if}
