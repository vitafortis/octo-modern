<script lang="ts">
	import { ChevronDown, ChevronUp, CircleAlert, FileCode2, GripVertical, HardDrive, LibraryBig, LoaderCircle, RotateCcw, Trash2, Upload } from '@lucide/svelte';
	import ActionMenu from '../ActionMenu.svelte';
	import { bytes, ago } from '#lib/client/format.ts';
	import { patchJob, removeJob, reorderJobs, queue } from '#lib/client/queue.svelte.ts';
	import { isAdmin, printers, session } from '#lib/client/state.svelte.ts';
	import { STATUS_LABEL, type QueueJob } from '#lib/queue.ts';

	let {
		jobs,
		reorderable = true,
		empty = 'Nothing queued.'
	}: {
		jobs: QueueJob[];
		/** Drag and up/down buttons (the full queue only). */
		reorderable?: boolean;
		empty?: string;
	} = $props();

	const printerName = (id: string | null) => (id ? (printers.list.find((p) => p.id === id)?.name ?? 'Removed printer') : null);
	/** Mirrors the server's rule: operators manage jobs for printers they control, and "any printer" jobs. */
	function canManage(j: QueueJob): boolean {
		const role = session.viewer?.role;
		if (role !== 'admin' && role !== 'operator') return false;
		if (!j.printerId) return true;
		const p = printers.list.find((x) => x.id === j.printerId);
		return p ? !!p.access?.control : isAdmin();
	}

	const pending = $derived(jobs.filter((j) => j.status === 'queued' || j.status === 'starting' || j.status === 'printing'));
	const finished = $derived(jobs.filter((j) => j.status === 'failed' || j.status === 'done'));

	// --- reordering ------------------------------------------------------------------------------
	let dragging = $state<string | null>(null);
	let over = $state<string | null>(null);

	/** The full pending order with `id` moved before `before` (or to the end). */
	function reordered(id: string, before: string | null): string[] {
		const all = queue.jobs.filter((j) => j.status === 'queued' || j.status === 'starting' || j.status === 'printing').map((j) => j.id);
		const rest = all.filter((x) => x !== id);
		const i = before ? rest.indexOf(before) : rest.length;
		rest.splice(i === -1 ? rest.length : i, 0, id);
		return rest;
	}

	async function apply(ids: string[]) {
		// Optimistic: reorder locally, then let the server confirm.
		const byId = new Map(queue.jobs.map((j) => [j.id, j]));
		const moved = ids.map((id) => byId.get(id)!).filter(Boolean);
		queue.jobs = [...moved, ...queue.jobs.filter((j) => !ids.includes(j.id))];
		await reorderJobs(ids);
	}

	function onDrop(target: string | null) {
		if (dragging && dragging !== target) void apply(reordered(dragging, target));
		dragging = over = null;
	}

	async function step(j: QueueJob, by: -1 | 1) {
		const list = pending.map((x) => x.id);
		const i = list.indexOf(j.id);
		const other = list[i + by];
		if (!other) return;
		// Move relative to the neighbour in this (possibly filtered) list.
		void apply(reordered(j.id, by === -1 ? other : (list[i + 2] ?? null)));
	}

	async function setCopies(j: QueueJob, value: string) {
		const n = Math.round(Number(value));
		if (!Number.isFinite(n) || n === j.copies) return;
		await patchJob(j.id, { copies: n });
	}

	const tone: Record<QueueJob['status'], string> = { queued: '', starting: 'badge-primary', printing: 'badge-primary', failed: 'badge-danger', done: 'badge-success' };
</script>

{#snippet row(j: QueueJob, index: number, inPending: boolean)}
	{@const manage = canManage(j)}
	{@const target = printerName(j.printerId)}
	{@const active = printerName(j.activePrinterId)}
	<li
		class="group relative flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:flex-nowrap sm:px-4 {over === j.id && dragging !== j.id ? 'before:absolute before:inset-x-0 before:-top-px before:h-0.5 before:bg-primary' : ''} {dragging === j.id ? 'opacity-50' : ''}"
		data-testid="queue-job"
		data-job={j.name}
		draggable={inPending && reorderable && manage}
		ondragstart={(e) => {
			dragging = j.id;
			e.dataTransfer?.setData('text/plain', j.id);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
		}}
		ondragover={(e) => {
			if (!dragging) return;
			e.preventDefault();
			over = j.id;
		}}
		ondragleave={() => over === j.id && (over = null)}
		ondrop={(e) => {
			e.preventDefault();
			onDrop(j.id);
		}}
		ondragend={() => (dragging = over = null)}
	>
		{#if inPending && reorderable}
			<div class="flex shrink-0 items-center gap-0.5">
				<span class="hidden cursor-grab text-muted-foreground/60 sm:inline {manage ? '' : 'invisible'}" aria-hidden="true"><GripVertical class="size-4" /></span>
				<span class="w-5 text-center font-mono text-[0.6875rem] text-muted-foreground tabular-nums">{index + 1}</span>
			</div>
		{/if}
		<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-muted-foreground" title={j.source === 'library' ? `Library: ${j.sourceName}` : j.source === 'printer' ? 'A file on the printer' : 'Uploaded'}>
			{#if j.source === 'library'}<LibraryBig class="size-4" />{:else if j.source === 'printer'}<HardDrive class="size-4" />{:else}<Upload class="size-4" />{/if}
		</span>
		<div class="min-w-0 flex-1 basis-40">
			<p class="flex items-center gap-1.5 truncate text-[0.8125rem] font-medium" title={j.path || j.name}><FileCode2 class="size-3.5 shrink-0 text-muted-foreground sm:hidden" />{j.name}</p>
			<p class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
				<span>{target ?? 'Any printer'}</span>
				{#each j.tags as t (t)}<span class="badge h-4.5 px-1.5 font-mono text-[0.625rem]">{t}</span>{/each}
				{#if j.size}<span>· {bytes(j.size)}</span>{/if}
				{#if j.createdBy}<span class="hidden sm:inline">· {j.createdBy}</span>{/if}
				<span class="hidden sm:inline">· {ago(j.createdAt)}</span>
			</p>
			{#if j.error}<p class="mt-1 flex items-start gap-1 text-[0.6875rem] text-danger"><CircleAlert class="mt-px size-3 shrink-0" />{j.error}</p>{/if}
			{#if j.runs.length}
				{@const r = j.runs[0]}
				<p class="mt-0.5 text-[0.6875rem] text-muted-foreground">
					Last run: {r.printerName} · {r.result}{r.endedAt ? ` · ${ago(r.endedAt)}` : ''}{#if r.printId}{' · '}<a class="text-primary hover:underline" href="/p/{encodeURIComponent(r.printerId)}?tab=history">history</a>{/if}
				</p>
			{/if}
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<span class="badge {tone[j.status]}" title={active ? `on ${active}` : ''}>
				{#if j.status === 'starting'}<LoaderCircle class="animate-spin" />{/if}{STATUS_LABEL[j.status]}{active && (j.status === 'printing' || j.status === 'starting') ? ` · ${active}` : ''}
			</span>
			<label class="flex items-center gap-1 text-[0.6875rem] text-muted-foreground" title="Copies printed / to print">
				<span class="font-mono tabular-nums">{j.done}/</span>
				{#if manage && j.status !== 'done'}
					<input class="input h-8 w-14 px-2 text-center font-mono text-xs tabular-nums touch:h-11" type="number" min="1" max="100" value={j.copies} aria-label="Copies of {j.name}" onchange={(e) => setCopies(j, e.currentTarget.value)} />
				{:else}
					<span class="font-mono tabular-nums">{j.copies}</span>
				{/if}
			</label>
		</div>
		{#if manage}
			<div class="hidden shrink-0 items-center gap-0.5 sm:flex">
				{#if inPending && reorderable}
					<button class="btn btn-ghost btn-icon btn-sm touch:size-11" title="Move up" aria-label="Move {j.name} up" disabled={index === 0} onclick={() => step(j, -1)}><ChevronUp /></button>
					<button class="btn btn-ghost btn-icon btn-sm touch:size-11" title="Move down" aria-label="Move {j.name} down" disabled={index === pending.length - 1} onclick={() => step(j, 1)}><ChevronDown /></button>
				{/if}
				{#if j.status === 'failed' || j.status === 'done'}
					<button class="btn btn-secondary btn-sm touch:h-11" onclick={() => patchJob(j.id, { requeue: true }, 'Could not requeue')}><RotateCcw />Requeue</button>
				{/if}
				<button class="btn btn-ghost btn-icon btn-sm hover:text-danger touch:size-11" title="Remove from the queue" aria-label="Remove {j.name}" onclick={() => removeJob(j)}><Trash2 /></button>
			</div>
			<!-- Phones: the row's actions in one sheet. -->
			<div class="ml-auto sm:hidden">
				<ActionMenu
					title={j.name}
					description={`${STATUS_LABEL[j.status]} · ${target ?? 'Any printer'}`}
					actions={[
						{ label: 'Move up', icon: ChevronUp, onclick: () => step(j, -1), hidden: !(inPending && reorderable), disabled: index === 0 },
						{ label: 'Move down', icon: ChevronDown, onclick: () => step(j, 1), hidden: !(inPending && reorderable), disabled: index === pending.length - 1 },
						{ label: 'Requeue', icon: RotateCcw, onclick: () => patchJob(j.id, { requeue: true }, 'Could not requeue'), hidden: !(j.status === 'failed' || j.status === 'done') },
						{ label: 'Remove from the queue', icon: Trash2, onclick: () => removeJob(j), danger: true }
					]}
				/>
			</div>
		{/if}
	</li>
{/snippet}

{#if !jobs.length}
	<div class="card px-4 py-8 text-center text-xs text-muted-foreground">{empty}</div>
{:else}
	{#if pending.length}
		<ul
			class="card divide-y divide-border overflow-hidden"
			aria-label="Queued jobs"
			ondragover={(e) => dragging && e.preventDefault()}
			ondrop={(e) => {
				if (e.target === e.currentTarget) onDrop(null);
			}}
		>
			{#each pending as j, i (j.id)}{@render row(j, i, true)}{/each}
		</ul>
	{/if}
	{#if finished.length}
		<h3 class="mt-6 mb-2 px-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Finished and failed</h3>
		<ul class="card divide-y divide-border overflow-hidden" aria-label="Finished jobs">
			{#each finished as j, i (j.id)}{@render row(j, i, false)}{/each}
		</ul>
	{/if}
{/if}
