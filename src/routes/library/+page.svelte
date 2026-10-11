<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { CircleCheck, CircleX, Clock, FileCode2, Layers, LibraryBig, LoaderCircle, Play, Send, Settings2, Thermometer, Weight, X } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import LibraryBrowser from '#lib/components/library/LibraryBrowser.svelte';
	import SendDialog from '#lib/components/library/SendDialog.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { cancelSend, listSends, listSources, thumbnailUrl } from '#lib/client/library.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import { ago, bytes } from '#lib/client/format.ts';
	import { isAdmin, printers } from '#lib/client/state.svelte.ts';
	import { formatDuration } from '#lib/printer.ts';
	import { isPrintable, parentPath, type LibraryEntry, type LibrarySend, type LibrarySourceSummary } from '#lib/library.ts';

	let sources = $state<LibrarySourceSummary[] | null>(null);
	let error = $state('');
	let sourceId = $state('');
	let path = $state('');
	let selected = $state<LibraryEntry | null>(null);
	let dialog = $state<{ open: boolean; entry: LibraryEntry | null; print: boolean }>({ open: false, entry: null, print: false });
	let sends = $state<LibrarySend[]>([]);
	const wide = new MediaQuery('(min-width: 1280px)', true);

	const source = $derived(sources?.find((s) => s.id === sourceId));
	/** Printers the user may send this source's files to. */
	const targets = $derived(source ? printers.list.filter((p) => p.access?.control && source.printers.includes(p.id)) : []);

	onMount(() => {
		listSources()
			.then((list) => {
				sources = list;
				const q = page.url.searchParams;
				let remembered = '';
				try {
					remembered = localStorage.getItem('ocm-library-source') ?? '';
				} catch {}
				sourceId = list.find((s) => s.id === q.get('source'))?.id ?? list.find((s) => s.id === remembered)?.id ?? list[0]?.id ?? '';
				if (q.get('source') === sourceId) path = q.get('path') ?? '';
			})
			.catch((err) => (error = errorMessage(err)));
		void refreshSends();
	});

	// Keep the place in the URL (reload, share a folder link) without adding history entries.
	$effect(() => {
		if (!sourceId) return;
		const q = new URLSearchParams({ source: sourceId, ...(path ? { path } : {}) });
		if (page.url.search !== `?${q}`) replaceState(`/library?${q}`, {});
		try {
			localStorage.setItem('ocm-library-source', sourceId);
		} catch {}
	});

	// Running transfers (e.g. started before navigating here): poll while any is active.
	let sendTimer: ReturnType<typeof setTimeout> | undefined;
	async function refreshSends() {
		clearTimeout(sendTimer);
		try {
			sends = (await listSends()).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 5);
		} catch {}
		if (sends.some((s) => s.state === 'sending' || s.state === 'processing')) sendTimer = setTimeout(refreshSends, 1000);
	}
	onMount(() => () => clearTimeout(sendTimer));

	// A transfer hidden mid-way keeps running: show it here.
	$effect(() => {
		if (!dialog.open && dialog.entry) void refreshSends();
	});

	function openSend(entry: LibraryEntry, print: boolean) {
		// The details sheet (below xl) makes way for the send dialog.
		if (!wide.current) selected = null;
		dialog = { open: true, entry, print };
	}

	const m = $derived(selected?.meta);
</script>

{#snippet fileDetails(sheet: boolean)}
	{#if selected}
						<section class="overflow-hidden {sheet ? '-mx-4 -my-4 sm:-mx-5' : 'card'}" data-testid="library-details">
							<div class="relative grid place-items-center border-b border-border bg-surface {sheet ? 'aspect-video max-h-[34vh] w-full' : 'aspect-[4/3]'}">
								{#if m?.thumbnail}
									<img src={thumbnailUrl(sourceId, selected)} alt="Preview of {selected.name}" class="size-full object-contain p-3" />
								{:else}
									<FileCode2 class="size-10 text-muted-foreground/50" />
								{/if}
								{#if !sheet}<button class="btn btn-ghost btn-icon btn-sm absolute top-2 right-2" aria-label="Close details" onclick={() => (selected = null)}><X /></button>{/if}
							</div>
							<div class="space-y-4 p-4">
								{#if !sheet}
									<div>
										<h2 class="text-[14px] leading-snug font-semibold break-all">{selected.name}</h2>
										<p class="mt-0.5 truncate text-[11px] text-muted-foreground">{source?.name}{parentPath(selected.path) ? ` / ${parentPath(selected.path)}` : ''}</p>
									</div>
								{/if}
								{#if m === undefined && isPrintable(selected.name)}
									<p class="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" />Reading slicer details…</p>
								{/if}
								<dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
									{#if m?.estimatedTime != null}
										<div><dt class="flex items-center gap-1 text-[11px] text-muted-foreground"><Clock class="size-3" />Print time</dt><dd class="font-mono tabular-nums">{formatDuration(m.estimatedTime)}</dd></div>
									{/if}
									{#if m?.filamentG != null || m?.filamentMm != null}
										<div>
											<dt class="flex items-center gap-1 text-[11px] text-muted-foreground"><Weight class="size-3" />Filament</dt>
											<dd class="font-mono tabular-nums">{m.filamentG != null ? `${m.filamentG.toFixed(1)} g` : ''}{m.filamentG != null && m.filamentMm != null ? ' · ' : ''}{m.filamentMm != null ? `${(m.filamentMm / 1000).toFixed(2)} m` : ''}</dd>
										</div>
									{/if}
									{#if m?.layerHeight != null}
										<div><dt class="flex items-center gap-1 text-[11px] text-muted-foreground"><Layers class="size-3" />Layers</dt><dd class="font-mono tabular-nums">{m.layerHeight} mm{m.layers ? ` × ${m.layers}` : ''}</dd></div>
									{/if}
									{#if m?.nozzle != null || m?.filamentType}
										<div><dt class="text-[11px] text-muted-foreground">Nozzle · material</dt><dd>{m.nozzle != null ? `${m.nozzle} mm` : '—'}{m.filamentType ? ` · ${m.filamentType}` : ''}</dd></div>
									{/if}
									{#if m?.nozzleTemp != null || m?.bedTemp != null}
										<div><dt class="flex items-center gap-1 text-[11px] text-muted-foreground"><Thermometer class="size-3" />Hotend · bed</dt><dd class="font-mono tabular-nums">{m.nozzleTemp ?? '—'}° · {m.bedTemp ?? '—'}°</dd></div>
									{/if}
									{#if m?.printerModel}
										<div><dt class="text-[11px] text-muted-foreground">Sliced for</dt><dd class="truncate" title={m.printerModel}>{m.printerModel}</dd></div>
									{/if}
									<div><dt class="text-[11px] text-muted-foreground">Size</dt><dd class="font-mono tabular-nums">{bytes(selected.size)}</dd></div>
									<div><dt class="text-[11px] text-muted-foreground">Modified</dt><dd title={selected.mtime ? new Date(selected.mtime).toLocaleString() : ''}>{selected.mtime ? ago(new Date(selected.mtime).toISOString()) : '—'}</dd></div>
									{#if m?.slicer}
										<div class="col-span-2"><dt class="text-[11px] text-muted-foreground">Slicer</dt><dd>{m.slicer}{m.slicerVersion ? ` ${m.slicerVersion}` : ''}{m.format === 'binary' ? ' · binary G-code' : ''}</dd></div>
									{/if}
								</dl>
								{#if targets.length && isPrintable(selected.name)}
									<div class="flex gap-2 pt-1">
										<button class="btn btn-secondary flex-1" onclick={() => openSend(selected!, false)}><Send />{targets.length === 1 ? `Send to ${targets[0].name}` : 'Send to…'}</button>
										<button class="btn btn-primary flex-1" onclick={() => openSend(selected!, true)}><Play />Send & print</button>
									</div>
								{:else if !targets.length && source}
									<p class="text-[11px] text-muted-foreground">{source.printers.length ? 'Your role can only browse the library.' : 'No printer you can see may use this source.'}</p>
								{/if}
							</div>
						</section>
	{/if}
{/snippet}

<svelte:head><title>Library · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Library" description="G-code on your NAS, ready to send to any printer.">
		{#snippet actions()}
			{#if isAdmin()}
				<a href="/library/sources" class="btn btn-secondary"><Settings2 />Sources</a>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="page-x pb-10">
		{#if error}
			<div class="card px-4 py-8 text-center text-xs text-danger">{error}</div>
		{:else if !sources}
			<div class="grid h-40 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
		{:else if !sources.length}
			<div class="card mx-auto mt-6 max-w-md px-6 py-10 text-center">
				<span class="mx-auto grid size-12 place-items-center rounded-xl bg-primary-soft text-primary"><LibraryBig class="size-6" /></span>
				<h2 class="mt-4 text-[15px] font-semibold tracking-tight">No library yet</h2>
				{#if isAdmin()}
					<p class="mt-1 text-[13px] text-muted-foreground">Point octo·modern at the folder on your NAS where your slicer saves G-code: an NFS or SMB share mounted into the container, an SMB share, SFTP or WebDAV.</p>
					<a href="/library/sources?new=1" class="btn btn-primary mt-5">Add a library source</a>
				{:else}
					<p class="mt-1 text-[13px] text-muted-foreground">An admin hasn't shared a library source with you yet.</p>
				{/if}
			</div>
		{:else}
			<div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
				<LibraryBrowser {sources} bind:sourceId bind:path bind:selected onopen={(e) => targets.length && openSend(e, false)}>
					{#snippet row(e)}
						{#if targets.length && isPrintable(e.name)}
							<button class="btn btn-ghost btn-icon btn-sm" title="Send to a printer" aria-label="Send {e.name}" onclick={() => openSend(e, false)}><Send /></button>
						{/if}
					{/snippet}
				</LibraryBrowser>

				<aside class="space-y-4 xl:sticky xl:top-4 xl:self-start">
					{#if selected && wide.current}
						{@render fileDetails(false)}
					{:else}
						<section class="card px-5 py-8 text-center text-xs text-muted-foreground max-xl:hidden">
							<FileCode2 class="mx-auto mb-2 size-6 opacity-50" />
							Select a file to see its preview, print time and filament{targets.length ? ', and send it to a printer' : ''}.
						</section>
					{/if}

					{#if sends.length}
						<section class="card divide-y divide-border">
							<h3 class="px-4 py-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">Recent transfers</h3>
							{#each sends as s (s.id)}
								{@const pct = s.size ? Math.round((s.sent / s.size) * 100) : 0}
								<div class="px-4 py-2.5 text-xs">
									<div class="flex items-center gap-2">
										{#if s.state === 'done'}<CircleCheck class="size-3.5 shrink-0 text-success" />{:else if s.state === 'error' || s.state === 'aborted'}<CircleX class="size-3.5 shrink-0 text-danger" />{:else}<LoaderCircle class="size-3.5 shrink-0 animate-spin text-primary" />{/if}
										<span class="min-w-0 flex-1 truncate font-medium" title={s.path}>{s.path.split('/').pop()}</span>
										{#if s.state === 'sending'}<button class="text-muted-foreground hover:text-danger" title="Cancel" aria-label="Cancel transfer" onclick={async () => (await cancelSend(s.id), refreshSends())}><X class="size-3.5" /></button>{/if}
									</div>
									<p class="mt-0.5 pl-5.5 text-[11px] text-muted-foreground">
										→ {s.printerName}{s.state === 'sending' ? ` · ${pct}%` : s.state === 'processing' ? ' · saving…' : s.state === 'done' ? (s.printing ? ' · printing' : ' · sent') : s.state === 'aborted' ? ' · cancelled' : ''} · {ago(s.startedAt)}
									</p>
									{#if s.error && s.state === 'error'}<p class="mt-0.5 pl-5.5 text-[11px] text-danger">{s.error}</p>{/if}
								</div>
							{/each}
						</section>
					{/if}
				</aside>
			</div>
		{/if}
	</div>
</div>

<!-- Below xl the details open as a sheet over the list instead of beside it. -->
{#if !wide.current}
	<Dialog bind:open={() => !!selected, (v) => !v && (selected = null)} title={selected?.name ?? ''} description={source ? `${source.name}${selected && parentPath(selected.path) ? ` / ${parentPath(selected.path)}` : ''}` : undefined}>
		{@render fileDetails(true)}
	</Dialog>
{/if}

{#if source && dialog.entry}
	<SendDialog bind:open={dialog.open} {source} entry={dialog.entry} print={dialog.print} onsent={refreshSends} />
{/if}
