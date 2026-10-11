<script lang="ts">
	import { onMount } from 'svelte';
	import { CircleAlert, CircleCheck, Clock, Wrench } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import MaintenancePanel from '#lib/components/maintenance/MaintenancePanel.svelte';
	import MaintenanceLog from '#lib/components/maintenance/MaintenanceLog.svelte';
	import { allMaintenance } from '#lib/client/spools.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { printers } from '#lib/client/state.svelte.ts';
	import type { MaintenanceLogEntry, MaintenanceTask } from '#lib/spools.ts';

	let tasks = $state<MaintenanceTask[]>([]);
	let log = $state<MaintenanceLogEntry[]>([]);
	let loaded = $state(false);
	let error = $state('');

	async function load() {
		try {
			({ tasks, log } = await allMaintenance());
			error = '';
		} catch (err) {
			error = errorMessage(err);
		} finally {
			loaded = true;
		}
	}
	onMount(() => void load());

	const overdue = $derived(tasks.filter((t) => t.status === 'overdue').length);
	const due = $derived(tasks.filter((t) => t.status === 'due').length);
	// Printers with something overdue first.
	const ordered = $derived(
		[...printers.list].sort((a, b) => {
			const score = (id: string) => tasks.filter((t) => t.printerId === id).reduce((m, t) => Math.max(m, t.progress), 0);
			return score(b.id) - score(a.id);
		})
	);
</script>

<svelte:head><title>Maintenance · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Maintenance" description="Reminders per printer, counted in print hours, filament or days from the print history." />
	<div class="page-x space-y-6 pb-10">
		{#if error}
			<div class="card px-4 py-6 text-center text-xs text-danger">{error}</div>
		{:else if loaded}
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<div class="card flex items-center gap-3 px-4 py-3.5">
					<div class="grid size-9 place-items-center rounded-lg {overdue ? 'bg-danger/10 text-danger' : 'bg-muted text-muted-foreground'}"><CircleAlert class="size-4" /></div>
					<div><p class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Overdue</p><p class="text-xl font-semibold tabular-nums" data-testid="overdue-count">{overdue}</p></div>
				</div>
				<div class="card flex items-center gap-3 px-4 py-3.5">
					<div class="grid size-9 place-items-center rounded-lg {due ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground'}"><Clock class="size-4" /></div>
					<div><p class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Due soon</p><p class="text-xl font-semibold tabular-nums">{due}</p></div>
				</div>
				<div class="card flex items-center gap-3 px-4 py-3.5">
					<div class="grid size-9 place-items-center rounded-lg bg-success/10 text-success"><CircleCheck class="size-4" /></div>
					<div><p class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">On track</p><p class="text-xl font-semibold tabular-nums">{tasks.length - overdue - due}</p></div>
				</div>
			</div>

			{#each ordered as p (p.id)}
				{@const mine = tasks.filter((t) => t.printerId === p.id)}
				<section class="space-y-2">
					<h2 class="flex items-center gap-2 text-[14px] font-semibold">
						<span class="size-2 rounded-full" style="background:{COLORS[p.color] ?? COLORS.violet}"></span>
						<a class="hover:underline" href="/p/{p.id}?tab=maintenance">{p.name}</a>
						{#if mine.some((t) => t.status === 'overdue')}<span class="badge badge-danger">overdue</span>{/if}
					</h2>
					<MaintenancePanel printerId={p.id} printerName={p.name} tasks={mine} canControl={!!p.access?.control} compact onchange={load} />
				</section>
			{:else}
				<div class="card px-6 py-10 text-center text-[13px] text-muted-foreground"><Wrench class="mx-auto mb-2 size-5" />No printers yet.</div>
			{/each}

			<MaintenanceLog {log} showPrinter />
		{/if}
	</div>
</div>
