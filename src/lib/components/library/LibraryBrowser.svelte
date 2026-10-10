<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { ArrowDownAZ, ChevronRight, FileCode2, File as FileIcon, Folder, LoaderCircle, RefreshCw, Search, X } from '@lucide/svelte';
	import Switch from '../Switch.svelte';
	import SourceIcon from './SourceIcon.svelte';
	import { fileMeta, listFolder, searchLibrary, thumbnailUrl } from '#lib/client/library.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import { ago, bytes } from '#lib/client/format.ts';
	import { formatDuration } from '#lib/printer.ts';
	import { isPrintable, parentPath, type LibraryEntry, type LibrarySourceSummary } from '#lib/library.ts';

	let {
		sources,
		sourceId = $bindable(),
		path = $bindable(''),
		selected = $bindable(null),
		compact = false,
		onopen,
		row
	}: {
		sources: LibrarySourceSummary[];
		sourceId: string;
		path?: string;
		selected?: LibraryEntry | null;
		/** Fewer columns (inside a dialog). */
		compact?: boolean;
		/** Double click / Enter on a file. */
		onopen?: (e: LibraryEntry) => void;
		/** Extra buttons at the end of a file's row. */
		row?: Snippet<[LibraryEntry]>;
	} = $props();

	let entries = $state<LibraryEntry[] | null>(null);
	let error = $state('');
	let loading = $state(false);
	let query = $state('');
	let searching = $state(false);
	let results = $state<LibraryEntry[] | null>(null);
	let truncated = $state(false);
	let sort = $state<'name' | 'date' | 'size'>('name');
	let showAll = $state(false);

	const source = $derived(sources.find((s) => s.id === sourceId));

	// --- loading ----------------------------------------------------------------------------
	let gen = 0;
	async function load() {
		const my = ++gen;
		if (!sourceId) return;
		loading = true;
		try {
			const l = await listFolder(sourceId, path);
			if (my !== gen) return;
			entries = l.entries;
			error = '';
		} catch (err) {
			if (my !== gen) return;
			entries = [];
			error = errorMessage(err);
		} finally {
			if (my === gen) loading = false;
		}
	}

	$effect(() => {
		void sourceId;
		void path;
		entries = null;
		void load();
	});

	// Search below the current folder, debounced.
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchCtrl: AbortController | undefined;
	$effect(() => {
		const q = query.trim();
		const all = showAll;
		void sourceId;
		void path;
		clearTimeout(searchTimer);
		searchCtrl?.abort();
		if (q.length < 2) {
			results = null;
			searching = false;
			return;
		}
		searching = true;
		searchTimer = setTimeout(async () => {
			searchCtrl = new AbortController();
			try {
				const r = await searchLibrary(sourceId, path, q, all, searchCtrl.signal);
				results = r.results;
				truncated = r.truncated;
				error = '';
			} catch (err) {
				if ((err as Error).name !== 'AbortError') error = errorMessage(err);
			} finally {
				searching = false;
			}
		}, 300);
	});

	// --- metadata, fetched lazily for printable files we haven't parsed before ----------------
	const metaLoading = new SvelteSet<string>();
	let metaQueue: LibraryEntry[] = [];
	let metaActive = 0;
	function pumpMeta(forSource: string) {
		while (metaActive < 3 && metaQueue.length) {
			const e = metaQueue.shift()!;
			metaActive++;
			metaLoading.add(e.path);
			fileMeta(forSource, e.path)
				.then(({ meta }) => {
					if (forSource !== sourceId) return;
					const apply = (list: LibraryEntry[] | null) => list?.forEach((x) => x.path === e.path && (x.meta = meta));
					apply(entries);
					apply(results);
					if (selected?.path === e.path) selected = { ...selected, meta };
				})
				.catch(() => {
					const apply = (list: LibraryEntry[] | null) => list?.forEach((x) => x.path === e.path && (x.meta = null));
					apply(entries);
					apply(results);
				})
				.finally(() => {
					metaActive--;
					metaLoading.delete(e.path);
					pumpMeta(forSource);
				});
		}
	}
	$effect(() => {
		const list = results ?? entries;
		if (!list) return;
		const id = sourceId;
		untrack(() => {
			metaQueue = list.filter((e) => e.type === 'file' && isPrintable(e.name) && e.meta === undefined && !metaLoading.has(e.path)).slice(0, 200);
			pumpMeta(id);
		});
	});

	// --- view -----------------------------------------------------------------------------
	const rows = $derived.by(() => {
		const list = (results ?? entries ?? []).filter((e) => e.type === 'folder' || showAll || isPrintable(e.name));
		const cmp = {
			name: (a: LibraryEntry, b: LibraryEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
			date: (a: LibraryEntry, b: LibraryEntry) => (b.mtime ?? 0) - (a.mtime ?? 0),
			size: (a: LibraryEntry, b: LibraryEntry) => (b.size ?? 0) - (a.size ?? 0)
		}[sort];
		return [...list].sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : cmp(a, b)));
	});
	const hiddenCount = $derived((results ?? entries ?? []).filter((e) => e.type === 'file' && !isPrintable(e.name)).length);
	const crumbs = $derived(path ? path.split('/').map((name, i, all) => ({ name, path: all.slice(0, i + 1).join('/') })) : []);

	function go(p: string) {
		query = '';
		results = null;
		selected = null;
		path = p;
	}

	function activate(e: LibraryEntry) {
		if (e.type === 'folder') go(e.path);
		else selected = e;
	}

	function onkeydown(e: KeyboardEvent, entry: LibraryEntry) {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (entry.type === 'folder') go(entry.path);
			else if (onopen) onopen(entry);
			else selected = entry;
		} else if (e.key === 'Backspace' && path && !query) {
			e.preventDefault();
			go(parentPath(path));
		}
	}
</script>

<div class="flex min-h-0 flex-col gap-3">
	{#if sources.length > 1}
		<div class="flex flex-wrap gap-1.5" role="tablist" aria-label="Library sources">
			{#each sources as s (s.id)}
				<button
					role="tab"
					aria-selected={s.id === sourceId}
					class="flex h-8 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors {s.id === sourceId
						? 'border-primary/40 bg-primary-soft text-foreground'
						: 'border-border bg-card text-muted-foreground hover:text-foreground'}"
					onclick={() => {
						if (s.id === sourceId) return;
						sourceId = s.id;
						go('');
					}}
				>
					<SourceIcon kind={s.kind} class="size-3.5 {s.id === sourceId ? 'text-primary' : ''}" />{s.name}
				</button>
			{/each}
		</div>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		<nav class="flex min-w-0 flex-1 items-center gap-1 text-[13px]" aria-label="Folder">
			<button class="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium hover:bg-accent {path ? 'text-muted-foreground' : ''}" onclick={() => go('')}>
				{#if source}<SourceIcon kind={source.kind} class="size-3.5" />{/if}{source?.name ?? 'Library'}
			</button>
			{#each crumbs as c (c.path)}
				<ChevronRight class="size-3.5 shrink-0 text-muted-foreground" />
				<button class="truncate rounded-md px-1.5 py-0.5 hover:bg-accent {c.path === path ? 'font-medium' : 'text-muted-foreground'}" onclick={() => go(c.path)}>{c.name}</button>
			{/each}
		</nav>
		<div class="flex flex-wrap items-center gap-2">
			<div class="relative">
				<Search class="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
				<input class="input h-8 {compact ? 'w-44' : 'w-56'} pr-7 pl-8 text-xs" placeholder={path ? 'Search this folder…' : 'Search everything…'} aria-label="Search the library" bind:value={query} />
				{#if searching}
					<LoaderCircle class="absolute top-2 right-2.5 size-3.5 animate-spin text-muted-foreground" />
				{:else if query}
					<button class="absolute top-1.5 right-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear search" onclick={() => (query = '')}><X class="size-3.5" /></button>
				{/if}
			</div>
			<label class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<ArrowDownAZ class="size-3.5" />
				<select class="input h-8 w-28 text-xs" bind:value={sort} aria-label="Sort by">
					<option value="name">Name</option>
					<option value="date">Newest</option>
					<option value="size">Size</option>
				</select>
			</label>
			<label class="flex items-center gap-2 text-xs text-muted-foreground" title="Show every file, not just G-code">
				<Switch label="All files" bind:checked={showAll} />All files
			</label>
			<button class="btn btn-ghost btn-icon btn-sm" title="Refresh" aria-label="Refresh" onclick={load} disabled={loading}><RefreshCw class={loading ? 'animate-spin' : ''} /></button>
		</div>
	</div>

	<div class="card min-h-0 overflow-hidden">
		{#if error}
			<p class="px-4 py-8 text-center text-xs text-danger">{error}</p>
		{:else if !entries}
			<div class="grid h-40 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
		{:else}
			<div class="max-h-[calc(100dvh-16rem)] overflow-y-auto {compact ? 'max-h-[min(52vh,32rem)]' : ''}">
				<table class="w-full text-left text-[13px]">
					<thead class="sticky top-0 z-10 border-b border-border bg-surface text-[11px] text-muted-foreground">
						<tr>
							<th class="px-4 py-2 font-medium">Name</th>
							<th class="hidden px-3 py-2 text-right font-medium md:table-cell">Print time</th>
							{#if !compact}<th class="hidden px-3 py-2 text-right font-medium lg:table-cell">Filament</th>{/if}
							<th class="hidden px-3 py-2 text-right font-medium sm:table-cell">Size</th>
							{#if !compact}<th class="hidden px-3 py-2 font-medium xl:table-cell">Modified</th>{/if}
							{#if row}<th class="px-3 py-2"><span class="sr-only">Actions</span></th>{/if}
						</tr>
					</thead>
					<tbody class="divide-y divide-border">
						{#if path && !query.trim()}
							<tr class="cursor-pointer hover:bg-accent/30" tabindex="0" onclick={() => go(parentPath(path))} onkeydown={(ev) => ev.key === 'Enter' && go(parentPath(path))}>
								<td colspan="6" class="px-4 py-1.5 text-xs text-muted-foreground">
									<span class="flex items-center gap-3"><span class="grid w-9 place-items-center">..</span>Up to {parentPath(path) || source?.name}</span>
								</td>
							</tr>
						{/if}
						{#each rows as e (e.path)}
							{@const printable = e.type === 'file' && isPrintable(e.name)}
							{@const isSel = selected?.path === e.path}
							<tr
								class="cursor-pointer outline-none hover:bg-accent/30 focus-visible:bg-accent/40 {isSel ? 'bg-primary-soft/60 hover:bg-primary-soft/70' : ''}"
								tabindex="0"
								data-entry={e.path}
								aria-selected={isSel}
								onclick={() => activate(e)}
								ondblclick={() => e.type === 'file' && onopen?.(e)}
								onkeydown={(ev) => onkeydown(ev, e)}
							>
								<td class="px-4 py-1.5">
									<div class="flex min-w-0 items-center gap-3">
										{#if e.meta?.thumbnail}
											<img src={thumbnailUrl(sourceId, e)} alt="" class="size-9 shrink-0 rounded-md border border-border bg-surface object-contain" loading="lazy" />
										{:else}
											<span class="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface text-muted-foreground">
												{#if e.type === 'folder'}<Folder class="size-4 text-primary" />{:else if printable && metaLoading.has(e.path)}<LoaderCircle class="size-3.5 animate-spin" />{:else if printable}<FileCode2 class="size-4" />{:else}<FileIcon class="size-4 opacity-60" />{/if}
											</span>
										{/if}
										<span class="min-w-0">
											<span class="block truncate font-medium {printable || e.type === 'folder' ? '' : 'text-muted-foreground'}">{e.name}</span>
											{#if query.trim() && e.path.includes('/')}
												<span class="block truncate text-[11px] text-muted-foreground">{parentPath(e.path)}</span>
											{:else if e.meta?.slicer && !compact}
												<span class="block truncate text-[11px] text-muted-foreground">{e.meta.slicer}{e.meta.filamentType ? ` · ${e.meta.filamentType}` : ''}{e.meta.layerHeight ? ` · ${e.meta.layerHeight} mm` : ''}</span>
											{/if}
										</span>
									</div>
								</td>
								<td class="hidden px-3 py-1.5 text-right font-mono text-xs tabular-nums md:table-cell">{e.meta?.estimatedTime != null ? formatDuration(e.meta.estimatedTime) : ''}</td>
								{#if !compact}
									<td class="hidden px-3 py-1.5 text-right font-mono text-xs text-muted-foreground tabular-nums lg:table-cell">
										{#if e.meta?.filamentG != null}{e.meta.filamentG.toFixed(e.meta.filamentG < 10 ? 1 : 0)} g{:else if e.meta?.filamentMm != null}{(e.meta.filamentMm / 1000).toFixed(2)} m{/if}
									</td>
								{/if}
								<td class="hidden px-3 py-1.5 text-right font-mono text-xs text-muted-foreground tabular-nums sm:table-cell">{e.type === 'file' ? bytes(e.size) : ''}</td>
								{#if !compact}
									<td class="hidden px-3 py-1.5 text-xs text-muted-foreground xl:table-cell" title={e.mtime ? new Date(e.mtime).toLocaleString() : ''}>{e.mtime ? ago(new Date(e.mtime).toISOString()) : ''}</td>
								{/if}
								{#if row}
									<td class="px-3 py-1.5 text-right" onclick={(ev) => ev.stopPropagation()}>{#if e.type === 'file'}{@render row(e)}{/if}</td>
								{/if}
							</tr>
						{:else}
							<tr>
								<td colspan="6" class="px-4 py-12 text-center text-xs text-muted-foreground">
									{#if searching}Searching…{:else if query.trim().length >= 2}Nothing matches “{query.trim()}”{path ? ' in this folder' : ''}.{:else if hiddenCount}No G-code here — {hiddenCount} other file{hiddenCount === 1 ? '' : 's'}. <button class="text-primary hover:underline" onclick={() => (showAll = true)}>Show all files</button>{:else}This folder is empty.{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if results && truncated}
				<p class="border-t border-border bg-surface px-4 py-2 text-[11px] text-muted-foreground">Showing the first {results.length} matches; the search stopped early. Narrow it down, or search inside a folder.</p>
			{:else if !results && hiddenCount && !showAll && rows.length}
				<p class="border-t border-border bg-surface px-4 py-2 text-[11px] text-muted-foreground">{hiddenCount} other file{hiddenCount === 1 ? '' : 's'} hidden. <button class="text-primary hover:underline" onclick={() => (showAll = true)}>Show all</button></p>
			{/if}
		{/if}
	</div>
</div>
