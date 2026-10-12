<script lang="ts">
	import { BrushCleaning, CirclePause, CirclePlay, KeyRound, ListOrdered, ListPlus, LoaderCircle, Pencil, Tags } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import StateBadge from '#lib/components/printer/StateBadge.svelte';
	import QueueList from '#lib/components/queue/QueueList.svelte';
	import AddJobDialog from '#lib/components/queue/AddJobDialog.svelte';
	import { bedClear, holdPrinter, pollQueue, queue, setPrinterTags, setQueuePaused } from '#lib/client/queue.svelte.ts';
	import { isAdmin, printers, session, statuses } from '#lib/client/state.svelte.ts';
	import { jobActive } from '#lib/printer.ts';
	import { parseTags } from '#lib/queue.ts';

	$effect(() => pollQueue());

	const canControl = $derived(session.viewer?.role === 'admin' || session.viewer?.role === 'operator');
	let adding = $state(false);
	let editing = $state<{ id: string; value: string } | null>(null);

	const rows = $derived(
		printers.list.map((p) => ({ p, q: queue.printers.find((x) => x.printerId === p.id), s: statuses[p.id], job: queue.jobs.find((j) => j.activePrinterId === p.id && (j.status === 'printing' || j.status === 'starting')) }))
	);
	const pendingCount = $derived(queue.jobs.filter((j) => j.status === 'queued').length);

	async function saveTags() {
		if (!editing) return;
		const { id, value } = editing;
		editing = null;
		await setPrinterTags(id, parseTags(value));
	}
</script>

<svelte:head><title>Queue · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Queue" description="Prints wait here for a free printer. Each starts once its printer is idle and someone confirms the bed is clear.">
		{#snippet actions()}
			{#if canControl}
				<button class="btn btn-secondary" onclick={() => setQueuePaused(!queue.paused)} data-testid="queue-pause">
					{#if queue.paused}<CirclePlay />Resume queue{:else}<CirclePause />Pause queue{/if}
				</button>
				<button class="btn btn-primary" onclick={() => (adding = true)}><ListPlus />Add job</button>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="page-x space-y-6 pb-10">
		{#if queue.paused}
			<div class="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-2.5 text-[0.8125rem]">
				<CirclePause class="size-4 shrink-0 text-warning" />
				<p class="min-w-0 flex-1"><span class="font-medium">The queue is paused.</span> <span class="text-muted-foreground">Running prints carry on; nothing new starts.</span></p>
			</div>
		{/if}

		<section>
			<h2 class="mb-2 px-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Printers</h2>
			<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{#each rows as { p, q, s, job } (p.id)}
					{@const control = !!p.access?.control}
					<div class="card flex flex-col gap-3 p-4" data-testid="queue-printer-{p.name}">
						<div class="flex items-start gap-2">
							<a href="/p/{p.id}?tab=jobs&view=queue" class="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight hover:underline">{p.name}</a>
							{#if s}<StateBadge state={s.state} text={s.stateText} />{/if}
						</div>
						<div class="flex flex-wrap items-center gap-1">
							<Tags class="size-3.5 text-muted-foreground" />
							{#if editing?.id === p.id}
								<form class="flex flex-1 gap-1" onsubmit={(e) => (e.preventDefault(), saveTags())}>
									<input class="input h-9 flex-1 font-mono text-xs" aria-label="Tags for {p.name}" placeholder="0.4mm, petg, bed:250" bind:value={editing.value} />
									<button class="btn btn-secondary btn-sm h-9">Save</button>
								</form>
							{:else}
								{#each q?.tags ?? [] as t (t)}<span class="badge font-mono text-[0.625rem]">{t}</span>{:else}<span class="text-[0.6875rem] text-muted-foreground">No tags</span>{/each}
								{#if isAdmin()}<button class="btn btn-ghost btn-icon size-9 sm:size-7" title="Edit tags" aria-label="Edit tags of {p.name}" onclick={() => (editing = { id: p.id, value: (q?.tags ?? []).join(', ') })}><Pencil /></button>{/if}
							{/if}
						</div>
						<div class="mt-auto text-xs">
							{#if job}
								<p class="truncate"><span class="text-muted-foreground">{job.status === 'starting' ? 'Starting' : 'Printing'}:</span> <span class="font-medium">{job.name}</span> <span class="text-muted-foreground">({job.done + 1}/{job.copies})</span></p>
							{:else if q?.held}
								<div class="flex items-center gap-2">
									<p class="min-w-0 flex-1 truncate text-warning" title={q.heldReason ?? ''}>Paused · {q.heldReason ?? 'by hand'}</p>
									{#if control}<button class="btn btn-secondary btn-sm min-h-9" onclick={() => holdPrinter(p.id, false)}><CirclePlay />Resume</button>{/if}
								</div>
							{:else if q?.awaitingClear && !(s && jobActive(s.state))}
								<div class="flex items-center gap-2">
									<p class="min-w-0 flex-1 text-muted-foreground">Bed not confirmed clear{q.waiting ? ` · ${q.waiting} waiting` : ''}</p>
									{#if control}<button class="btn {q.waiting ? 'btn-primary' : 'btn-secondary'} btn-sm min-h-9" onclick={() => bedClear(p.id, p.name)}><BrushCleaning />Bed is clear</button>{/if}
								</div>
							{:else}
								<div class="flex items-center gap-2">
									<p class="min-w-0 flex-1 text-muted-foreground">{s && jobActive(s.state) ? 'Busy (not from the queue)' : q?.waiting ? `Ready · ${q.waiting} waiting` : 'Ready · nothing waiting for it'}</p>
									{#if control}<button class="btn btn-ghost btn-sm min-h-9" title="Stop sending queued jobs to this printer" onclick={() => holdPrinter(p.id, true)}><CirclePause />Pause</button>{/if}
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</section>

		<section>
			<h2 class="mb-2 flex items-center gap-2 px-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">
				Jobs{#if pendingCount}<span class="badge badge-primary normal-case">{pendingCount} queued</span>{/if}
			</h2>
			{#if !queue.loaded}
				<div class="grid h-32 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
			{:else if !queue.jobs.length}
				<div class="card mx-auto max-w-md px-6 py-10 text-center">
					<span class="mx-auto grid size-12 place-items-center rounded-xl bg-primary-soft text-primary"><ListOrdered class="size-6" /></span>
					<h3 class="mt-4 text-[0.9375rem] font-semibold tracking-tight">Nothing queued</h3>
					<p class="mt-1 text-[0.8125rem] text-muted-foreground">Add G-code from the library, a printer’s files or an upload; or point your slicer at octo·modern.</p>
					{#if canControl}<button class="btn btn-primary mt-5" onclick={() => (adding = true)}><ListPlus />Add job</button>{/if}
				</div>
			{:else}
				<QueueList jobs={queue.jobs} />
			{/if}
		</section>

		{#if isAdmin()}
			<p class="flex items-start gap-1.5 px-1 text-[0.6875rem] text-muted-foreground">
				<KeyRound class="mt-px size-3.5 shrink-0" />
				<span>Slicers (PrusaSlicer, OrcaSlicer, Cura) can upload straight into the queue: create a <a class="text-primary hover:underline" href="/integrations#slicer">slicer upload key</a> and add octo·modern as an OctoPrint printer at <code class="font-mono">{typeof location === 'undefined' ? '' : location.origin}/octoprint</code>.</span>
			</p>
		{/if}
	</div>
</div>

<AddJobDialog bind:open={adding} />
