<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		ArrowDownAZ,
		Box,
		ChevronRight,
		CircleCheck,
		CircleX,
		FileCode2,
		Folder,
		FolderPlus,
		HardDrive,
		LibraryBig,
		LoaderCircle,
		MemoryStick,
		Play,
		RefreshCw,
		Save,
		Search,
		Trash2,
		Upload as UploadIcon,
		X
	} from '@lucide/svelte';
	import Switch from '../Switch.svelte';
	import { createFolder, deleteFile, GCODE_ACCEPT, isGcodeName, listFiles, printFile, thumbnailUrl, uploadFile, type Upload } from '#lib/client/files.ts';
	import { ago, bytes } from '#lib/client/format.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { formatDuration, jobActive } from '#lib/printer.ts';
	import { features } from '#lib/printer-kind.ts';
	import type { FileEntry, FileListing } from '#lib/types.ts';
	import type { TabProps } from './tabs.ts';
	import LibraryPickerDialog from '../library/LibraryPickerDialog.svelte';
	import SaveToLibraryDialog from '../library/SaveToLibraryDialog.svelte';
	import { listSources } from '#lib/client/library.ts';
	import type { LibrarySourceSummary } from '#lib/library.ts';
	import ActionMenu from '../ActionMenu.svelte';
	import { ListPlus } from '@lucide/svelte';
	import { addPrinterFileJob } from '#lib/client/queue.svelte.ts';
	import { listLayout } from '#lib/client/viewport.svelte.ts';

	let { printer, live, canControl }: TabProps = $props();
	// Klipper starts a file when it loads it: no "load without printing".
	const canLoad = $derived(features(printer).selectWithoutPrint);
	const serverName = $derived(printer.kind === 'moonraker' ? 'Klipper' : 'OctoPrint');

	/** The printer page's Preview tab for a file (the date busts the parsed-file cache after a re-upload). */
	const canPreview = (f: FileEntry) => f.type === 'machinecode' && f.origin === 'local' && !/\.bgcode$/i.test(f.name);
	const previewHref = (f: FileEntry) => `?tab=preview&file=${encodeURIComponent(f.path)}&v=${f.date ?? ''}-${f.size ?? ''}`;

	let listing = $state<FileListing | null>(null);
	let error = $state('');
	let loading = $state(false);
	let origin = $state<'local' | 'sdcard'>('local');
	let folder = $state('');
	let query = $state('');
	let sort = $state<'date' | 'name' | 'size'>('date');
	let printAfterUpload = $state(false);
	let uploads = $state<Upload[]>([]);
	let dragging = $state(0);
	let fileInput = $state<HTMLInputElement>();
	let newFolder = $state<string | null>(null);

	// Library sources this printer may print from (and save to, when writable).
	let librarySources = $state<LibrarySourceSummary[]>([]);
	let picker = $state(false);
	let saving = $state<FileEntry | null>(null);
	const writableSources = $derived(librarySources.filter((x) => x.writable));

	async function load() {
		loading = true;
		try {
			listing = await listFiles(printer.id);
			error = '';
		} catch (err) {
			error = errorMessage(err);
		} finally {
			loading = false;
		}
	}

	// Refresh when OctoPrint says files changed (uploads from slicers, analysis results…).
	let timer: ReturnType<typeof setTimeout> | undefined;
	const soon = () => {
		clearTimeout(timer);
		timer = setTimeout(load, 400);
	};
	onMount(() => {
		void load();
		if (canControl) listSources().then((list) => (librarySources = list.filter((x) => x.printers.includes(printer.id)))).catch(() => {});
		const offs = ['UpdatedFiles', 'FileAdded', 'FileRemoved', 'FolderAdded', 'FolderRemoved', 'MetadataAnalysisFinished', 'MetadataStatisticsUpdated'].map((e) => live.on(e, soon));
		return () => {
			offs.forEach((off) => off());
			clearTimeout(timer);
		};
	});

	const s = $derived(live.snapshot);
	const ready = $derived(s.state === 'operational');
	const busy = $derived(new Set(live.busyFiles.map((b) => `${b.origin}:${b.path}`)));
	const current = $derived(s.job?.file ? `${s.job.file.origin}:${s.job.file.path}` : null);
	const hasSd = $derived(!!listing?.files.some((f) => f.origin === 'sdcard'));

	function findFolder(entries: FileEntry[], path: string): FileEntry[] {
		if (!path) return entries;
		let level = entries;
		let acc = '';
		for (const seg of path.split('/')) {
			acc = acc ? `${acc}/${seg}` : seg;
			const f = level.find((e) => e.type === 'folder' && e.path === acc);
			if (!f) return [];
			level = f.children ?? [];
		}
		return level;
	}
	const flatten = (entries: FileEntry[]): FileEntry[] => entries.flatMap((e) => [e, ...(e.children ? flatten(e.children) : [])]);

	const rows = $derived.by(() => {
		if (!listing) return [];
		const all = listing.files.filter((f) => f.origin === origin);
		const q = query.trim().toLowerCase();
		const list = q ? flatten(all).filter((f) => f.type !== 'folder' && `${f.display} ${f.path}`.toLowerCase().includes(q)) : findFolder(all, folder);
		const cmp = {
			date: (a: FileEntry, b: FileEntry) => (b.date ?? 0) - (a.date ?? 0),
			name: (a: FileEntry, b: FileEntry) => a.display.localeCompare(b.display, undefined, { numeric: true }),
			size: (a: FileEntry, b: FileEntry) => (b.size ?? 0) - (a.size ?? 0)
		}[sort];
		return [...list].sort((a, b) => ((a.type === 'folder') !== (b.type === 'folder') ? (a.type === 'folder' ? -1 : 1) : cmp(a, b)));
	});
	const crumbs = $derived(folder ? folder.split('/').map((name, i, all) => ({ name, path: all.slice(0, i + 1).join('/') })) : []);

	function track(u: Upload) {
		const i = uploads.findIndex((x) => x.id === u.id);
		if (i === -1) uploads.push({ ...u });
		else uploads[i] = { ...u };
	}

	function startUploads(files: FileList | File[] | null | undefined) {
		if (!canControl || !files) return;
		const list = [...files];
		const bad = list.filter((f) => !isGcodeName(f.name));
		if (bad.length) toast('error', 'Only G-code can be uploaded here', bad.map((f) => f.name).join(', '));
		const good = list.filter((f) => isGcodeName(f.name));
		// "Print after upload" applies to a single file only.
		const print = printAfterUpload && good.length === 1;
		for (const file of good) {
			uploadFile(printer.id, file, { path: origin === 'sdcard' ? '' : folder, origin: 'local', print }, track)
				.then((r) => {
					if (print && r.preparing) toast('info', 'Uploaded; preparing the printer', `${file.name} starts once the pre-print steps have finished.`);
					else if (print) toast(r.printing ? 'success' : 'info', r.printing ? 'Uploaded and printing' : 'Uploaded', r.printing ? file.name : `${file.name}: the printer wasn’t ready, so it didn’t start.`);
					else toast('success', 'Uploaded', file.name);
					void load();
				})
				.catch((err) => {
					if (!/cancelled/.test(String(err))) toast('error', `Upload of ${file.name} failed`, errorMessage(err));
				})
				.finally(() => setTimeout(() => (uploads = uploads.filter((x) => x.state === 'uploading' || x.state === 'processing')), 4000));
		}
	}

	function ondrop(e: DragEvent) {
		e.preventDefault();
		dragging = 0;
		startUploads(e.dataTransfer?.files);
	}

	async function addFolder(e: SubmitEvent) {
		e.preventDefault();
		if (!newFolder?.trim()) return;
		if (await createFolder(printer.id, newFolder.trim(), folder)) {
			newFolder = null;
			await load();
		}
	}

	function open(f: FileEntry) {
		if (f.type === 'folder') {
			folder = f.path;
			query = '';
		}
	}
</script>

<div
	class="relative space-y-4"
	role="region"
	aria-label="Files"
	ondragenter={(e) => {
		if (!canControl || !e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragging++;
	}}
	ondragover={(e) => canControl && e.dataTransfer?.types.includes('Files') && e.preventDefault()}
	ondragleave={() => (dragging = Math.max(0, dragging - 1))}
	{ondrop}
>
	<div class="flex flex-wrap items-center gap-2">
		{#if hasSd}
			<div class="inline-flex rounded-lg border border-border bg-surface p-0.5">
				<button class="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs {origin === 'local' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => ((origin = 'local'), (folder = ''))}><HardDrive class="size-3.5" />OctoPrint</button>
				<button class="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs {origin === 'sdcard' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => ((origin = 'sdcard'), (folder = ''))}><MemoryStick class="size-3.5" />SD card</button>
			</div>
		{/if}
		<nav class="flex min-w-0 items-center gap-1 text-[0.8125rem]" aria-label="Folder">
			<button class="rounded-md px-1.5 py-0.5 font-medium hover:bg-accent {folder ? 'text-muted-foreground' : ''}" onclick={() => (folder = '')}>{origin === 'sdcard' ? 'SD card' : 'Files'}</button>
			{#each crumbs as c (c.path)}
				<ChevronRight class="size-3.5 shrink-0 text-muted-foreground" />
				<button class="truncate rounded-md px-1.5 py-0.5 hover:bg-accent {c.path === folder ? 'font-medium' : 'text-muted-foreground'}" onclick={() => (folder = c.path)}>{c.name}</button>
			{/each}
		</nav>
		<div class="ml-auto flex flex-wrap items-center gap-2 max-md:w-full">
			<div class="relative max-md:min-w-0 max-md:flex-1">
				<Search class="absolute top-2 left-2.5 size-3.5 text-muted-foreground touch:top-3.5 touch:size-4" />
				<input class="input h-8 w-52 pl-8 text-xs max-md:w-full touch:pl-9" placeholder="Search all files…" aria-label="Search files" bind:value={query} />
			</div>
			<label class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<ArrowDownAZ class="size-3.5 max-sm:hidden" />
				<select class="input h-8 w-28 text-xs max-sm:w-[6.5rem]" bind:value={sort} aria-label="Sort by">
					<option value="date">Newest</option>
					<option value="name">Name</option>
					<option value="size">Size</option>
				</select>
			</label>
			<button class="btn btn-ghost btn-icon btn-sm" title="Refresh" aria-label="Refresh" onclick={load} disabled={loading}><RefreshCw class={loading ? 'animate-spin' : ''} /></button>
			{#if canControl && origin === 'local'}
				<div class="flex flex-wrap items-center gap-2 max-md:w-full">
					<button class="btn btn-secondary btn-sm max-md:flex-1" onclick={() => (newFolder = '')}><FolderPlus />Folder</button>
					{#if librarySources.length}<button class="btn btn-secondary btn-sm max-md:flex-1" onclick={() => (picker = true)}><LibraryBig />From library</button>{/if}
					<label class="flex items-center gap-2 text-xs text-muted-foreground max-md:order-last max-md:w-full max-md:py-1" title="Start printing right after the upload (one file at a time, and only when the printer is ready)">
						<Switch label="Print after upload" bind:checked={printAfterUpload} />Print after upload
					</label>
					<!-- On touch screens there's nothing to drag from: this button is the way in. -->
					<button class="btn btn-primary btn-sm max-md:flex-1" onclick={() => fileInput?.click()}><UploadIcon />Upload</button>
				</div>
				<input bind:this={fileInput} type="file" accept={GCODE_ACCEPT} multiple class="hidden" data-testid="file-input" onchange={(e) => (startUploads(e.currentTarget.files), (e.currentTarget.value = ''))} />
			{/if}
		</div>
	</div>

	{#if newFolder !== null}
		<form class="flex flex-wrap items-center gap-2" onsubmit={addFolder}>
			<Folder class="size-4 text-muted-foreground" />
			<!-- svelte-ignore a11y_autofocus -->
			<input class="input h-8 w-64 text-xs max-sm:min-w-0 max-sm:flex-1" placeholder="New folder name" aria-label="New folder name" autofocus bind:value={newFolder} />
			<button class="btn btn-primary btn-sm" disabled={!newFolder.trim()}>Create</button>
			<button type="button" class="btn btn-ghost btn-sm" onclick={() => (newFolder = null)}>Cancel</button>
		</form>
	{/if}

	{#if uploads.length}
		<div class="card divide-y divide-border">
			{#each uploads as u (u.id)}
				{@const pct = u.size ? Math.round((u.loaded / u.size) * 100) : 0}
				<div class="flex items-center gap-3 px-4 py-2.5 text-[0.8125rem]">
					{#if u.state === 'done'}<CircleCheck class="size-4 text-success" />{:else if u.state === 'error' || u.state === 'aborted'}<CircleX class="size-4 text-danger" />{:else}<LoaderCircle class="size-4 animate-spin text-primary" />{/if}
					<span class="min-w-0 flex-1 truncate">{u.name}</span>
					<div class="h-1.5 w-48 overflow-hidden max-sm:w-16 rounded-full bg-muted"><div class="h-full rounded-full transition-[width] {u.state === 'error' ? 'bg-danger' : 'bg-primary'}" style="width:{pct}%"></div></div>
					<span class="w-40 text-right font-mono text-[0.6875rem] text-muted-foreground max-sm:hidden">
						{u.state === 'processing' ? `${serverName} is saving…` : u.state === 'error' ? 'failed' : u.state === 'aborted' ? 'cancelled' : u.state === 'done' ? 'done' : `${bytes(u.loaded)} / ${bytes(u.size)}`}
					</span>
					{#if u.state === 'uploading'}<button class="btn btn-ghost btn-icon btn-sm" title="Cancel upload" aria-label="Cancel upload" onclick={u.abort}><X /></button>{/if}
				</div>
				{#if u.error}<p class="px-4 pb-2.5 pl-11 text-xs text-danger">{u.error}</p>{/if}
			{/each}
		</div>
	{/if}

	<div class="card overflow-hidden">
		{#if error}
			<p class="px-4 py-6 text-center text-xs text-danger">{error}</p>
		{:else if !listing}
			<div class="grid h-32 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
		{:else if listLayout.current}
			<!-- Phones: one row per file, the essentials, Print at hand and the rest in a menu. -->
			<ul class="divide-y divide-border" data-testid="file-list">
				{#each rows as f (`${f.origin}:${f.path}`)}
					{@const key = `${f.origin}:${f.path}`}
					{@const inUse = busy.has(key)}
					<li class="flex items-center gap-3 px-3 py-2.5 {current === key ? 'bg-primary-soft/50' : ''}" data-file={f.path}>
						<button class="flex min-w-0 flex-1 items-center gap-3 text-left" onclick={() => open(f)} tabindex={f.type === 'folder' ? 0 : -1} title={f.path}>
							{#if f.thumbnail}
								<img src={thumbnailUrl(printer.id, f.thumbnail)} alt="" class="size-11 shrink-0 rounded-md border border-border bg-surface object-contain" loading="lazy" />
							{:else}
								<span class="grid size-11 shrink-0 place-items-center rounded-md border border-border bg-surface text-muted-foreground">
									{#if f.type === 'folder'}<Folder class="size-5 text-primary" />{:else}<FileCode2 class="size-5" />{/if}
								</span>
							{/if}
							<span class="min-w-0 flex-1">
								<span class="line-clamp-2 text-sm leading-snug font-medium [overflow-wrap:anywhere]">{f.display}</span>
								<span class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
									{#if f.type === 'folder'}
										{f.children?.length ?? 0} items
									{:else}
										{#if query.trim() && f.path.includes('/')}<span class="truncate">{f.path.split('/').slice(0, -1).join('/')}/</span>{/if}
										{#if f.estimatedPrintTime != null}<span class="font-mono">{formatDuration(f.estimatedPrintTime)}</span>{/if}
										<span class="font-mono">{bytes(f.size)}</span>
										{#if f.date}<span>{ago(new Date(f.date * 1000).toISOString())}</span>{/if}
										{#if f.prints?.lastSuccess != null}
											<span class={f.prints.lastSuccess ? 'text-success' : 'text-danger'} title="Last print">{#if f.prints.lastSuccess}<CircleCheck class="inline size-3" />{:else}<CircleX class="inline size-3" />{/if}</span>
										{/if}
									{/if}
									{#if current === key}<span class="badge badge-primary">selected</span>{/if}
									{#if inUse && current !== key}<span class="badge badge-warning">in use</span>{/if}
								</span>
							</span>
							{#if f.type === 'folder'}<ChevronRight class="size-4 shrink-0 text-muted-foreground" />{/if}
						</button>
						{#if canControl && f.type === 'machinecode'}
							<button class="btn btn-primary btn-icon btn-sm" disabled={!ready} aria-label="Print {f.display}" title={ready ? `Print ${f.display}` : jobActive(s.state) ? 'A print is already running' : 'Connect the printer first'} onclick={() => printFile(printer.id, f, true)}><Play /></button>
						{/if}
						<ActionMenu
							title={f.display}
							description={f.type === 'folder' ? 'Folder' : [bytes(f.size), f.estimatedPrintTime != null ? formatDuration(f.estimatedPrintTime) : null].filter(Boolean).join(' · ')}
							actions={[
								{ label: 'Preview toolpath', icon: Box, hidden: !canPreview(f), onclick: () => goto(previewHref(f)) },
								{ label: 'Print', icon: Play, hidden: !canControl || f.type !== 'machinecode', disabled: !ready, hint: ready ? undefined : jobActive(s.state) ? 'A print is already running' : 'Connect the printer first', onclick: () => printFile(printer.id, f, true) },
								{ label: 'Load without printing', icon: FileCode2, hidden: !canControl || !canLoad || f.type !== 'machinecode', disabled: !ready || current === key, onclick: () => printFile(printer.id, f, false) },
								{ label: 'Add to queue', icon: ListPlus, hidden: !(canControl && f.type === 'machinecode' && f.origin === 'local'), hint: 'Prints here once the bed is confirmed clear', onclick: () => addPrinterFileJob(printer.id, f.path) },
								{ label: 'Save to library', icon: Save, hidden: !(canControl && f.type === 'machinecode' && f.origin === 'local' && writableSources.length), onclick: () => (saving = f) },
								{ label: `Delete ${f.type === 'folder' ? 'folder' : 'file'}`, icon: Trash2, danger: true, hidden: !canControl, disabled: inUse, hint: inUse ? `In use by ${serverName}` : undefined, onclick: async () => (await deleteFile(printer.id, f)) && load() }
							]}
						/>
					</li>
				{:else}
					<li class="px-4 py-12 text-center text-xs text-muted-foreground">
						{#if query.trim()}Nothing matches “{query}”.{:else if canControl && origin === 'local'}No files here yet. Use Upload to add G-code.{:else}No files.{/if}
					</li>
				{/each}
			</ul>
			{#if listing.free != null}
				<p class="border-t border-border bg-surface px-4 py-2 text-[0.6875rem] text-muted-foreground">{bytes(listing.free)} free{listing.total ? ` of ${bytes(listing.total)}` : ''} on {serverName}</p>
			{/if}
		{:else}
			<table class="w-full text-left text-[0.8125rem]">
				<thead class="border-b border-border bg-surface text-[0.6875rem] text-muted-foreground">
					<tr>
						<th class="px-4 py-2 font-medium">Name</th>
						<th class="hidden px-3 py-2 text-right font-medium md:table-cell">Size</th>
						<th class="hidden px-3 py-2 font-medium lg:table-cell">Uploaded</th>
						<th class="hidden px-3 py-2 text-right font-medium md:table-cell">Print time</th>
						<th class="hidden px-3 py-2 text-right font-medium lg:table-cell">Filament</th>
						<th class="hidden px-3 py-2 font-medium xl:table-cell">Last print</th>
						<th class="w-44 px-4 py-2"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each rows as f (`${f.origin}:${f.path}`)}
						{@const key = `${f.origin}:${f.path}`}
						{@const inUse = busy.has(key)}
						<tr class="hover:bg-accent/30 {current === key ? 'bg-primary-soft/50' : ''}" data-file={f.path}>
							<td class="px-4 py-2">
								<button class="flex min-w-0 items-center gap-3 text-left {f.type === 'folder' ? 'cursor-pointer' : 'cursor-default'}" onclick={() => open(f)} tabindex={f.type === 'folder' ? 0 : -1}>
									{#if f.thumbnail}
										<img src={thumbnailUrl(printer.id, f.thumbnail)} alt="" class="size-9 shrink-0 rounded-md border border-border bg-surface object-contain" loading="lazy" />
									{:else}
										<span class="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface text-muted-foreground">
											{#if f.type === 'folder'}<Folder class="size-4 text-primary" />{:else}<FileCode2 class="size-4" />{/if}
										</span>
									{/if}
									<span class="min-w-0">
										<span class="block truncate font-medium">{f.display}</span>
										{#if query.trim() && f.path.includes('/')}<span class="block truncate text-[0.6875rem] text-muted-foreground">{f.path}</span>{/if}
										{#if f.type === 'folder'}<span class="block text-[0.6875rem] text-muted-foreground">{f.children?.length ?? 0} items</span>{/if}
									</span>
									{#if current === key}<span class="badge badge-primary ml-1">selected</span>{/if}
									{#if inUse && current !== key}<span class="badge badge-warning ml-1">in use</span>{/if}
								</button>
							</td>
							<td class="hidden px-3 py-2 text-right font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums md:table-cell">{f.type === 'folder' ? '' : bytes(f.size)}</td>
							<td class="hidden px-3 py-2 text-xs text-muted-foreground lg:table-cell" title={f.date ? new Date(f.date * 1000).toLocaleString() : ''}>{f.date ? ago(new Date(f.date * 1000).toISOString()) : ''}</td>
							<td class="hidden px-3 py-2 text-right font-mono text-xs tabular-nums md:table-cell">{f.estimatedPrintTime != null ? formatDuration(f.estimatedPrintTime) : ''}</td>
							<td class="hidden px-3 py-2 text-right font-mono text-xs tabular-nums lg:table-cell">{f.filamentMm != null ? `${(f.filamentMm / 1000).toFixed(2)} m` : ''}</td>
							<td class="hidden px-3 py-2 text-xs xl:table-cell">
								{#if f.prints?.lastSuccess != null}
									<span class="flex items-center gap-1 {f.prints.lastSuccess ? 'text-success' : 'text-danger'}">
										{#if f.prints.lastSuccess}<CircleCheck class="size-3.5" />{:else}<CircleX class="size-3.5" />{/if}
										{f.prints.lastDate ? ago(new Date(f.prints.lastDate * 1000).toISOString()) : ''}
									</span>
								{/if}
							</td>
							<td class="px-4 py-2">
								<div class="flex items-center justify-end gap-1">
									{#if canPreview(f)}
										<a class="btn btn-ghost btn-icon btn-sm" href={previewHref(f)} title="Preview toolpath" aria-label="Preview {f.display}"><Box /></a>
									{/if}
									{#if canControl}
										{#if f.type === 'machinecode'}
											<button
												class="btn btn-primary btn-sm"
												disabled={!ready}
												title={ready ? `Print ${f.display}` : jobActive(s.state) ? 'A print is already running' : 'Connect the printer first'}
												onclick={() => printFile(printer.id, f, true)}><Play />Print</button
											>
											{#if canLoad}<button class="btn btn-ghost btn-sm" disabled={!ready || current === key} title="Load without starting" onclick={() => printFile(printer.id, f, false)}>Load</button>{/if}
										{/if}
										{#if f.type === 'machinecode' && f.origin === 'local'}
											<button class="btn btn-ghost btn-icon btn-sm" title="Add to the queue (prints here once the bed is confirmed clear)" aria-label="Queue {f.display}" onclick={() => addPrinterFileJob(printer.id, f.path)}><ListPlus /></button>
										{/if}
										{#if f.type === 'machinecode' && f.origin === 'local' && writableSources.length}
											<button class="btn btn-ghost btn-icon btn-sm" title="Save to library" aria-label="Save {f.display} to library" onclick={() => (saving = f)}><Save /></button>
										{/if}
										<button
											class="btn btn-ghost btn-icon btn-sm hover:text-danger"
											title={inUse ? `In use by ${serverName}` : `Delete ${f.display}`}
											aria-label="Delete {f.display}"
											disabled={inUse}
											onclick={async () => (await deleteFile(printer.id, f)) && load()}><Trash2 /></button
										>
									{/if}
								</div>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="7" class="px-4 py-12 text-center text-xs text-muted-foreground">
								{#if query.trim()}Nothing matches “{query}”.{:else if canControl && origin === 'local'}No files here yet. Drop G-code anywhere on this page, or use Upload.{:else}No files.{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if listing.free != null}
				<p class="border-t border-border bg-surface px-4 py-2 text-[0.6875rem] text-muted-foreground">{bytes(listing.free)} free{listing.total ? ` of ${bytes(listing.total)}` : ''} on {serverName}</p>
			{/if}
		{/if}
	</div>

	{#if dragging > 0}
		<div class="pointer-events-none absolute -inset-2 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-primary-soft/80 backdrop-blur-sm">
			<div class="text-center">
				<UploadIcon class="mx-auto size-8 text-primary" />
				<p class="mt-2 text-[0.9375rem] font-semibold">Drop G-code to upload</p>
				<p class="text-xs text-muted-foreground">to {folder || 'the top folder'}{printAfterUpload ? ', then print it' : ''}</p>
			</div>
		</div>
	{/if}
</div>

{#if librarySources.length}
	<LibraryPickerDialog bind:open={picker} sources={librarySources} printerId={printer.id} printerName={printer.name} folder={origin === 'sdcard' ? '' : folder} onsent={() => load()} />
{/if}
{#if saving}
	<SaveToLibraryDialog bind:open={() => !!saving, (v) => !v && (saving = null)} printerId={printer.id} file={saving} sources={writableSources} />
{/if}
