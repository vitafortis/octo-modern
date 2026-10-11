<script lang="ts">
	import { Check, ListPlus, Pencil, Plus, Trash2, Wrench } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import { addDefaultTasks, addTask, editTask, markDone, removeTask, type TaskForm } from '#lib/client/spools.ts';
	import { ago } from '#lib/client/format.ts';
	import { DEFAULT_TASKS, METRIC_UNIT, usageLabel, type MaintenanceMetric, type MaintenanceTask } from '#lib/spools.ts';

	/** One printer's maintenance tasks: status, mark done, add/edit/remove. */
	let {
		printerId,
		printerName,
		tasks,
		canControl,
		compact = false,
		onchange
	}: { printerId: string; printerName: string; tasks: MaintenanceTask[]; canControl: boolean; compact?: boolean; onchange: () => void } = $props();

	const STATUS = {
		ok: { label: 'OK', badge: 'badge-success', bar: 'bg-success' },
		due: { label: 'Due soon', badge: 'badge-warning', bar: 'bg-warning' },
		overdue: { label: 'Overdue', badge: 'badge-danger', bar: 'bg-danger' }
	} as const;

	// Mark done
	let doneTask = $state<MaintenanceTask | null>(null);
	let doneNotes = $state('');
	let busy = $state(false);

	// Add / edit
	let formOpen = $state(false);
	let editing = $state<MaintenanceTask | null>(null);
	let form = $state<TaskForm & { lastDone: string }>({ name: '', metric: 'hours', interval: 100, notes: '', lastDone: '' });

	// Recommended tasks
	let defaultsOpen = $state(false);
	let picked = $state<string[]>(DEFAULT_TASKS.map((d) => d.key));
	let defaultsSince = $state('');

	const today = () => new Date().toISOString().slice(0, 10);

	function openAdd() {
		editing = null;
		form = { name: '', metric: 'hours', interval: 100, notes: '', lastDone: '' };
		formOpen = true;
	}

	function openEdit(t: MaintenanceTask) {
		editing = t;
		form = { name: t.name, metric: t.metric, interval: t.interval, notes: t.notes ?? '', lastDone: '' };
		formOpen = true;
	}

	async function submitForm(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const t: TaskForm = { name: form.name, metric: form.metric, interval: Number(form.interval), notes: form.notes || null };
		if (form.lastDone) t.lastDoneAt = new Date(`${form.lastDone}T12:00:00`).toISOString();
		const ok = editing ? await editTask(printerId, editing.id, t) : await addTask(printerId, t);
		busy = false;
		if (ok) {
			formOpen = false;
			onchange();
		}
	}

	async function submitDone() {
		if (!doneTask) return;
		busy = true;
		const ok = await markDone(printerId, doneTask, doneNotes);
		busy = false;
		if (ok) {
			doneTask = null;
			onchange();
		}
	}

	async function submitDefaults() {
		busy = true;
		const ok = await addDefaultTasks(printerId, picked, defaultsSince ? new Date(`${defaultsSince}T12:00:00`).toISOString() : null);
		busy = false;
		if (ok) {
			defaultsOpen = false;
			onchange();
		}
	}

	const missingDefaults = $derived(DEFAULT_TASKS.filter((d) => !tasks.some((t) => t.name.toLowerCase() === d.name.toLowerCase())));
</script>

<div class="space-y-2" data-maintenance-printer={printerId}>
	{#if !tasks.length}
		<div class="card relative overflow-hidden px-6 py-10 text-center">
			<div class="dot-grid mask-fade pointer-events-none absolute inset-0"></div>
			<div class="relative mx-auto max-w-md">
				<div class="mx-auto grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><Wrench class="size-5" /></div>
				<h3 class="mt-4 text-[15px] font-semibold tracking-tight">No maintenance reminders yet</h3>
				<p class="mt-1.5 text-[13px] text-muted-foreground">Track nozzle changes, belts, lubrication and more by print hours, filament used or days.</p>
				{#if canControl}
					<div class="mt-4 flex flex-wrap justify-center gap-2">
						<button class="btn btn-primary btn-sm" onclick={() => ((picked = DEFAULT_TASKS.map((d) => d.key)), (defaultsOpen = true))}><ListPlus />Add recommended tasks</button>
						<button class="btn btn-secondary btn-sm" onclick={openAdd}><Plus />Custom task</button>
					</div>
				{/if}
			</div>
		</div>
	{:else}
		<ul class="card divide-y divide-border overflow-hidden">
			{#each tasks as t (t.id)}
				{@const st = STATUS[t.status]}
				<li class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-task={t.name} data-status={t.status}>
					<div class="min-w-0 flex-1 basis-56">
						<p class="flex flex-wrap items-center gap-2 text-[13px] font-medium">
							{t.name}
							<span class="badge {st.badge}">{#if t.status !== 'ok'}<span class="size-1.5 rounded-full bg-current"></span>{/if}{st.label}</span>
						</p>
						<p class="mt-0.5 text-[11px] text-muted-foreground">
							Every {t.interval} {METRIC_UNIT[t.metric]} · {t.lastDoneAt ? `done ${ago(t.lastDoneAt)}${t.lastDoneBy ? ` by ${t.lastDoneBy}` : ''}` : `tracking since ${new Date(t.createdAt).toLocaleDateString()}`}
						</p>
						{#if t.notes && !compact}<p class="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/80">{t.notes}</p>{/if}
					</div>
					<div class="w-full sm:w-44">
						<div class="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums"><span>{usageLabel(t)}</span><span>{Math.round(t.progress * 100)}%</span></div>
						<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-label="{t.name}: {Math.round(t.progress * 100)}% of the interval" aria-valuenow={Math.round(Math.min(1, t.progress) * 100)} aria-valuemin={0} aria-valuemax={100}>
							<div class="h-full rounded-full {st.bar}" style="width:{Math.min(1, t.progress) * 100}%"></div>
						</div>
					</div>
					{#if canControl}
						<div class="flex items-center gap-1">
							<button class="btn btn-secondary btn-sm min-h-9" aria-label="Mark {t.name} done" onclick={() => ((doneTask = t), (doneNotes = ''))}><Check />Done</button>
							<button class="btn btn-ghost btn-icon min-h-9 min-w-9" title="Edit" aria-label="Edit {t.name}" onclick={() => openEdit(t)}><Pencil /></button>
							<button class="btn btn-ghost btn-icon min-h-9 min-w-9 hover:text-danger" title="Remove" aria-label="Remove {t.name}" onclick={async () => (await removeTask(printerId, t)) && onchange()}><Trash2 /></button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
		{#if canControl}
			<div class="flex flex-wrap gap-2">
				<button class="btn btn-ghost btn-sm" onclick={openAdd}><Plus />Add task</button>
				{#if missingDefaults.length}
					<button class="btn btn-ghost btn-sm" onclick={() => ((picked = missingDefaults.map((d) => d.key)), (defaultsOpen = true))}><ListPlus />Recommended tasks</button>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<Dialog bind:open={() => !!doneTask, (v) => !v && (doneTask = null)} title="Mark “{doneTask?.name ?? ''}” done" description="{printerName} · the count starts again from now">
	{#if doneTask}
		<p class="text-[13px] text-muted-foreground">At {usageLabel(doneTask)} {doneTask.metric === 'days' ? '' : `(${METRIC_UNIT[doneTask.metric]})`}. It’s logged with your name and the time.</p>
		<label class="mt-3 block"><span class="label">Notes</span>
			<textarea id="maintenance-notes" class="input h-24 resize-y py-2 text-[13px]" placeholder="Parts used, what you found…" maxlength="2000" bind:value={doneNotes}></textarea>
		</label>
	{/if}
	{#snippet footer()}
		<button class="btn btn-ghost btn-sm" onclick={() => (doneTask = null)}>Cancel</button>
		<button class="btn btn-primary btn-sm" disabled={busy} onclick={submitDone}><Check />Mark done</button>
	{/snippet}
</Dialog>

<Dialog bind:open={formOpen} title={editing ? `Edit “${editing.name}”` : 'Add a maintenance task'} description={printerName}>
	<form id="task-form" class="grid gap-3 sm:grid-cols-2" onsubmit={submitForm}>
		<label class="sm:col-span-2"><span class="label">Task</span><input id="task-name" class="input" required maxlength="80" placeholder="Change nozzle" bind:value={form.name} /></label>
		<label><span class="label">Every</span><input id="task-interval" class="input" type="number" min="0.01" step="any" required bind:value={form.interval} /></label>
		<label><span class="label">Counted in</span>
			<select id="task-metric" class="input" bind:value={form.metric}>
				{#each Object.entries(METRIC_UNIT) as [k, label] (k)}<option value={k as MaintenanceMetric}>{label}</option>{/each}
			</select>
		</label>
		{#if !editing}
			<label class="sm:col-span-2"><span class="label">Last done (optional)</span>
				<input class="input" type="date" max={today()} bind:value={form.lastDone} />
				<span class="mt-1 block text-[11px] text-muted-foreground">Counts the print history since then; empty starts counting today.</span>
			</label>
		{/if}
		<label class="sm:col-span-2"><span class="label">Notes</span><textarea class="input h-20 resize-y py-2 text-[13px]" maxlength="1000" bind:value={form.notes}></textarea></label>
	</form>
	{#snippet footer()}
		<button class="btn btn-ghost btn-sm" onclick={() => (formOpen = false)}>Cancel</button>
		<button class="btn btn-primary btn-sm" type="submit" form="task-form" disabled={busy}>{editing ? 'Save' : 'Add task'}</button>
	{/snippet}
</Dialog>

<Dialog bind:open={defaultsOpen} title="Recommended maintenance" description="{printerName} · adjust the intervals later to suit your printer">
	<ul class="space-y-1">
		{#each DEFAULT_TASKS.filter((d) => missingDefaults.includes(d)) as d (d.key)}
			<li>
				<label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-accent/50">
					<input type="checkbox" class="mt-0.5 size-4 accent-[var(--primary)]" value={d.key} bind:group={picked} />
					<span>
						<span class="block text-[13px] font-medium">{d.name} <span class="font-normal text-muted-foreground">· every {d.interval} {METRIC_UNIT[d.metric]}</span></span>
						<span class="block text-[11px] text-muted-foreground">{d.notes}</span>
					</span>
				</label>
			</li>
		{/each}
	</ul>
	<label class="mt-3 block"><span class="label">Last done (optional)</span>
		<input class="input" type="date" max={today()} bind:value={defaultsSince} />
		<span class="mt-1 block text-[11px] text-muted-foreground">Counts the print history since then; empty starts counting today.</span>
	</label>
	{#snippet footer()}
		<button class="btn btn-ghost btn-sm" onclick={() => (defaultsOpen = false)}>Cancel</button>
		<button class="btn btn-primary btn-sm" disabled={busy || !picked.length} onclick={submitDefaults}>Add {picked.length} task{picked.length === 1 ? '' : 's'}</button>
	{/snippet}
</Dialog>
