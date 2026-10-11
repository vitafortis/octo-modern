<script lang="ts">
	import { Activity, Flame, Plus, Printer as PrinterIcon, Wifi } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import PrinterCard from '#lib/components/printer/PrinterCard.svelte';
	import { editor, isAdmin, printers, statuses } from '#lib/client/state.svelte.ts';

	const snaps = $derived(printers.list.map((p) => statuses[p.id]).filter(Boolean));
	const stats = $derived([
		{ label: 'Printers', value: printers.list.length, icon: PrinterIcon },
		{ label: 'Online', value: snaps.filter((s) => s.state !== 'offline' && s.state !== 'unknown').length, icon: Wifi },
		{ label: 'Printing', value: snaps.filter((s) => s.state === 'printing' || s.state === 'paused' || s.state === 'pausing').length, icon: Activity },
		{ label: 'Heating', value: snaps.filter((s) => Object.values(s.temps).some((t) => (t.target ?? 0) > 0)).length, icon: Flame }
	]);
</script>

<svelte:head><title>Overview · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Overview" description="Every OctoPrint server, live.">
		{#snippet actions()}
			{#if isAdmin()}<button class="btn btn-primary" onclick={() => (editor.target = 'new')}><Plus />Add printer</button>{/if}
		{/snippet}
	</PageHeader>

	<div class="page-x space-y-4 pb-10 sm:space-y-6">
		{#if printers.list.length === 0}
			<div class="card relative overflow-hidden px-6 py-16 text-center">
				<div class="dot-grid mask-fade pointer-events-none absolute inset-0"></div>
				<div class="relative mx-auto max-w-md">
					<div class="mx-auto grid size-12 place-items-center rounded-xl bg-primary-soft text-primary"><PrinterIcon class="size-6" /></div>
					<h2 class="mt-4 text-lg font-semibold tracking-tight">No printers yet</h2>
					<p class="mt-1.5 text-sm text-muted-foreground">
						Add an OctoPrint server with its URL and an API key. octo·modern keeps the key on the server and talks to OctoPrint for you.
					</p>
					{#if isAdmin()}
						<button class="btn btn-primary mt-6" onclick={() => (editor.target = 'new')}><Plus />Add printer</button>
					{:else}
						<p class="mt-4 text-xs text-muted-foreground">Ask an admin to add a printer or share one with you.</p>
					{/if}
				</div>
			</div>
		{:else}
			<div class="grid grid-cols-4 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4">
				{#each stats as s (s.label)}
					<div class="card flex items-center justify-between px-3 py-2.5 sm:p-4">
						<div class="min-w-0">
							<p class="truncate text-[11px] text-muted-foreground sm:text-xs">{s.label}</p>
							<p class="mt-0.5 text-xl font-semibold tracking-tight tabular-nums sm:mt-1 sm:text-2xl">{s.value}</p>
						</div>
						<div class="hidden size-9 place-items-center rounded-lg bg-primary-soft text-primary sm:grid"><s.icon class="size-4" /></div>
					</div>
				{/each}
			</div>
			<div class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
				{#each printers.list as p (p.id)}
					<PrinterCard printer={p} snapshot={statuses[p.id]} />
				{/each}
			</div>
		{/if}
	</div>
</div>
