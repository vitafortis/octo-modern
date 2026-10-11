<script lang="ts">
	import { BrushCleaning, CirclePause, CirclePlay, ListPlus } from '@lucide/svelte';
	import QueueList from '../queue/QueueList.svelte';
	import AddJobDialog from '../queue/AddJobDialog.svelte';
	import { bedClear, holdPrinter, pollQueue, queue, queuePrinter } from '#lib/client/queue.svelte.ts';
	import { jobActive } from '#lib/printer.ts';
	import type { TabProps } from './tabs.ts';

	let { printer, live, canControl }: TabProps = $props();

	$effect(() => pollQueue());
	const q = $derived(queuePrinter(printer.id));
	const tags = $derived(q?.tags ?? []);
	/** Jobs for this printer, and "any printer" jobs it could take. */
	const jobs = $derived(queue.jobs.filter((j) => j.printerId === printer.id || j.activePrinterId === printer.id || (!j.printerId && j.tags.every((t) => tags.includes(t)) && j.status !== 'done')));
	const printing = $derived(jobActive(live.snapshot.state));
	let adding = $state(false);
</script>

<div class="mx-auto max-w-5xl space-y-4">
	<section class="card flex flex-wrap items-center gap-3 p-4">
		<div class="min-w-0 flex-1 basis-60">
			<h2 class="text-sm font-semibold tracking-tight">Print queue</h2>
			<p class="mt-0.5 text-xs text-muted-foreground">
				{#if queue.paused}The whole queue is paused.{:else if q?.held}Paused for this printer: {q.heldReason ?? 'by hand'}.{:else if q?.awaitingClear && !printing}Waiting for someone to confirm the bed is clear.{:else if printing}Printing; the next job starts after the bed is cleared.{:else}Ready for the next job.{/if}
				{#if tags.length}<span class="ml-1">Tags: {#each tags as t (t)}<span class="badge mr-1 font-mono text-[0.625rem]">{t}</span>{/each}</span>{/if}
			</p>
		</div>
		{#if canControl}
			<div class="flex flex-wrap gap-2">
				{#if q?.awaitingClear && !printing}<button class="btn btn-primary touch:h-11" onclick={() => bedClear(printer.id, printer.name)}><BrushCleaning />Bed is clear</button>{/if}
				{#if q?.held}<button class="btn btn-secondary touch:h-11" onclick={() => holdPrinter(printer.id, false)}><CirclePlay />Resume</button>{:else}<button class="btn btn-secondary touch:h-11" onclick={() => holdPrinter(printer.id, true)}><CirclePause />Pause</button>{/if}
				<button class="btn btn-secondary touch:h-11" onclick={() => (adding = true)}><ListPlus />Add job</button>
			</div>
		{/if}
	</section>
	<QueueList {jobs} reorderable={false} empty="Nothing queued for this printer. Add jobs here, from the Files tab, the Library or the Queue page." />
	<p class="text-[0.6875rem] text-muted-foreground">Order and copies for every printer are on the <a class="text-primary hover:underline" href="/queue">Queue</a> page.</p>
</div>

<AddJobDialog bind:open={adding} printerId={printer.id} />
