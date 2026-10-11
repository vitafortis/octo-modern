<script lang="ts">
	import { ListPlus, LoaderCircle, Upload } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import LibraryBrowser from '../library/LibraryBrowser.svelte';
	import { listSources } from '#lib/client/library.ts';
	import { addLibraryJob, uploadJob } from '#lib/client/queue.svelte.ts';
	import { printers } from '#lib/client/state.svelte.ts';
	import { bytes } from '#lib/client/format.ts';
	import { isPrintable, type LibraryEntry, type LibrarySourceSummary } from '#lib/library.ts';
	import { parseTags } from '#lib/queue.ts';

	let {
		open = $bindable(false),
		preset = null,
		printerId: fixedPrinter = null
	}: {
		open: boolean;
		/** A library file chosen beforehand (from the Library page). */
		preset?: { source: LibrarySourceSummary; entry: LibraryEntry } | null;
		/** Preselect this printer as the target (printer page). */
		printerId?: string | null;
	} = $props();

	let mode = $state<'library' | 'upload'>('library');
	let sources = $state<LibrarySourceSummary[]>([]);
	let sourceId = $state('');
	let path = $state('');
	let selected = $state<LibraryEntry | null>(null);
	let file = $state<File | null>(null);
	let target = $state<string>('');
	let tags = $state('');
	let copies = $state(1);
	let busy = $state(false);
	let progress = $state(0);

	$effect(() => {
		if (!open) return;
		busy = false;
		progress = 0;
		file = null;
		copies = 1;
		target = fixedPrinter ?? '';
		if (preset) {
			mode = 'library';
			return;
		}
		listSources()
			.then((list) => {
				sources = list;
				if (!list.some((s) => s.id === sourceId)) sourceId = list[0]?.id ?? '';
				if (!list.length) mode = 'upload';
			})
			.catch(() => (mode = 'upload'));
	});

	const source = $derived(preset?.source ?? sources.find((s) => s.id === sourceId));
	const entry = $derived(preset?.entry ?? selected);
	/** Printers this user may queue to (for library files: those the source is open to). */
	const choices = $derived(printers.list.filter((p) => p.access?.control && (mode === 'upload' || !source || source.printers.includes(p.id))));
	const ready = $derived(mode === 'upload' ? !!file : !!entry && entry.type === 'file' && isPrintable(entry.name) && !!source);

	async function add() {
		if (!ready || busy) return;
		busy = true;
		const t = { printerId: target || null, tags: target ? [] : parseTags(tags), copies: Math.max(1, Math.min(100, Math.round(copies) || 1)) };
		const r = mode === 'upload' ? await uploadJob(file!, t, (f) => (progress = f)) : await addLibraryJob(source!.id, entry!.path, t);
		busy = false;
		if (r) open = false;
	}
</script>

<Dialog bind:open title="Add to the queue" description={preset ? preset.entry.name : 'Pick G-code from the library or upload a file.'} width={preset ? 'max-w-lg' : 'max-w-4xl'}>
	{#if !preset}
		<div class="mb-4 inline-flex rounded-lg border border-border bg-surface p-0.5" role="tablist">
			{#each [['library', 'From the library'], ['upload', 'Upload']] as [id, label] (id)}
				<button
					role="tab"
					aria-selected={mode === id}
					class="h-9 rounded-md px-3 text-[0.8125rem] font-medium {mode === id ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
					onclick={() => (mode = id as 'library' | 'upload')}
					disabled={id === 'library' && !sources.length}>{label}</button
				>
			{/each}
		</div>
		{#if mode === 'library' && sourceId}
			<LibraryBrowser {sources} bind:sourceId bind:path bind:selected compact onopen={() => add()} />
		{:else if mode === 'upload'}
			<label class="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center text-[0.8125rem] hover:border-primary/50" data-testid="queue-upload">
				<Upload class="size-6 text-muted-foreground" />
				{#if file}<span class="font-medium">{file.name}</span><span class="text-[0.6875rem] text-muted-foreground">{bytes(file.size)}</span>{:else}<span>Choose a G-code file</span>{/if}
				<input type="file" class="sr-only" accept=".gcode,.gco,.g,.gc,.bgcode" onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)} />
			</label>
			{#if busy}<div class="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-primary" style="width:{Math.round(progress * 100)}%"></div></div>{/if}
		{/if}
	{/if}

	<div class="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_6rem]">
		<label>
			<span class="label">Printer</span>
			<select class="input h-9" bind:value={target}>
				<option value="">Any compatible printer</option>
				{#each choices as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
			</select>
		</label>
		<label>
			<span class="label">Required tags</span>
			<input class="input h-9 font-mono text-xs" placeholder={target ? 'only for “any printer”' : 'e.g. 0.4mm, petg'} disabled={!!target} bind:value={tags} />
		</label>
		<label>
			<span class="label">Copies</span>
			<input class="input h-9 font-mono" type="number" min="1" max="100" bind:value={copies} />
		</label>
	</div>

	{#snippet footer()}
		<span class="mr-auto min-w-0 truncate text-xs text-muted-foreground">
			{#if mode === 'library' && entry}{entry.name} · {bytes(entry.size)}{:else if mode === 'library'}Select a file{/if}
		</span>
		<button class="btn btn-secondary" onclick={() => (open = false)}>Cancel</button>
		<button class="btn btn-primary" disabled={!ready || busy} onclick={add}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<ListPlus />{/if}Add to queue</button>
	{/snippet}
</Dialog>
