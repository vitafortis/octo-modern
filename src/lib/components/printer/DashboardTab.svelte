<script lang="ts">
	import { Box, CircleAlert, Gauge, Radio } from '@lucide/svelte';
	import JobCard from './JobCard.svelte';
	import PowerCard from '../power/PowerCard.svelte';
	import TemperatureCard from './TemperatureCard.svelte';
	import WebcamView from './WebcamView.svelte';
	import { ago } from '#lib/client/format.ts';
	import type { TabProps } from './tabs.ts';

	let { printer, live, canControl }: TabProps = $props();
	const s = $derived(live.snapshot);
</script>

<div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
	<div class="min-w-0 space-y-4">
		{#if s.state === 'error' && s.printerError}
			<div class="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-[13px]">
				<CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
				<div><p class="font-medium">The printer reported an error</p><p class="mt-0.5 font-mono text-xs text-muted-foreground">{s.printerError}</p></div>
			</div>
		{/if}
		<WebcamView printerId={printer.id} compact class="w-full" height="min(24rem, 40vh)" />
		<TemperatureCard {live} {canControl} />
	</div>
	<div class="space-y-4">
		<JobCard {live} {canControl} />
		<PowerCard {printer} {canControl} />
		<section class="card p-4 text-[13px]">
			<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Gauge class="size-4 text-primary" />Server</h2>
			<dl class="mt-3 space-y-2">
				<div class="flex justify-between gap-3"><dt class="text-muted-foreground">OctoPrint</dt><dd class="font-mono text-xs">{s.version ?? printer.octoprintVersion ?? '—'}</dd></div>
				<div class="flex justify-between gap-3"><dt class="text-muted-foreground">State</dt><dd class="truncate text-xs">{s.stateText}</dd></div>
				<div class="flex justify-between gap-3">
					<dt class="text-muted-foreground">Updates</dt>
					<dd class="flex items-center gap-1.5 text-xs">
						{#if s.source === 'push'}<Radio class="size-3.5 text-success" />live push{:else if s.source === 'poll'}<Box class="size-3.5 text-warning" />polling{:else}—{/if}
					</dd>
				</div>
				<div class="flex justify-between gap-3"><dt class="text-muted-foreground">Last update</dt><dd class="text-xs">{s.updatedAt ? ago(new Date(s.updatedAt).toISOString()) : 'never'}</dd></div>
			</dl>
		</section>
	</div>
</div>
