<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { CalendarRange, Download, FileCode2, History, ImageOff, Import, LoaderCircle, NotebookPen, RotateCcw, Search, Trash2 } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import WeeklyChart from './WeeklyChart.svelte';
	import { csvUrl, deleteEntry, historyStats, importHistory, listHistory, reprint, saveNotes, thumbnailUrl } from '#lib/client/history.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { isAdmin, printers, toast } from '#lib/client/state.svelte.ts';
	import { listLayout } from '#lib/client/viewport.svelte.ts';
	import { formatDuration } from '#lib/printer.ts';
	import { RESULT_LABEL, resultTone, type HistoryFilter, type HistoryStats, type PrintRecord, type PrintResult } from '#lib/history.ts';
	import type { LivePrinter } from '#lib/client/live.svelte.ts';
	import { formatMoney } from '#lib/spools.ts';

	/** With `printerId`, one printer's history (the printer tab); without, every printer's (the History page). */
	let { printerId, live }: { printerId?: string; live?: LivePrinter } = $props();

	const PAGE = 50;
	let filter = $state<HistoryFilter>({ printer: '', result: '', from: '', to: '', q: '' });
	const query = $derived<HistoryFilter>({ ...filter, printer: printerId ?? filter.printer });
	let items = $state<PrintRecord[]>([]);
	let total = $state(0);
	let stats = $state<HistoryStats | null>(null);
	let loading = $state(false);
	let loaded = $state(false);
	let error = $state('');
	let selected = $state<PrintRecord | null>(null);
	let dialogOpen = $state(false);
	let notes = $state('');
	let savingNotes = $state(false);
	let importing = $state(false);

	const filtered = $derived(!!(filter.result || filter.from || filter.to || filter.q?.trim() || (!printerId && filter.printer)));

	async function load() {
		loading = true;
		try {
			const q = $state.snapshot(query);
			const [list, s] = await Promise.all([listHistory(q, { limit: Math.max(PAGE, items.length) }), historyStats(q)]);
			items = list.items;
			total = list.total;
			stats = s;
			error = '';
		} catch (err) {
			error = errorMessage(err);
		} finally {
			loading = false;
			loaded = true;
		}
	}

	async function more() {
		loading = true;
		try {
			const list = await listHistory($state.snapshot(query), { limit: PAGE, before: items.at(-1)?.id });
			items = [...items, ...list.items];
		} catch (err) {
			toast('error', 'Could not load more', errorMessage(err));
		} finally {
			loading = false;
		}
	}

	let timer: ReturnType<typeof setTimeout>;
	$effect(() => {
		void [query.printer, query.result, query.from, query.to, query.q];
		clearTimeout(timer);
		timer = setTimeout(() => untrack(() => ((items = []), load())), 200);
	});

	// New and finished prints: from the printer's live events on its tab, else a slow refresh.
	onMount(() => {
		let soon: ReturnType<typeof setTimeout> | undefined;
		const refresh = () => {
			clearTimeout(soon);
			// The picture is taken right after the print ends; give it a moment.
			soon = setTimeout(load, 3000);
		};
		const offs = live ? ['PrintStarted', 'PrintDone', 'PrintFailed', 'PrintCancelled', 'PrintPaused', 'PrintResumed'].map((e) => live.on(e, refresh)) : [];
		const every = setInterval(() => document.visibilityState === 'visible' && !dialogOpen && void load(), live ? 60_000 : 20_000);
		return () => {
			offs.forEach((off) => off());
			clearTimeout(soon);
			clearInterval(every);
		};
	});

	const printerName = (r: PrintRecord) => printers.list.find((p) => p.id === r.printerId)?.name ?? r.printerName;
	const canControl = (r: PrintRecord) => !!printers.list.find((p) => p.id === r.printerId)?.access?.control;
	const who = (r: PrintRecord) => r.startedBy ?? (r.source === 'import' ? (r.octoprintUser ? `${r.octoprintUser} (OctoPrint)` : 'imported') : 'OctoPrint');
	const badge = (r: PrintResult) => ({ success: 'badge-success', danger: 'badge-danger', warning: 'badge-warning', primary: 'badge-primary', muted: '' })[resultTone(r)];
	const meters = (mm: number | null | undefined) => (mm == null ? '—' : `${(mm / 1000).toFixed(mm < 100_000 ? 2 : 0)} m`);
	const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
	const money = (n: number | null | undefined) => formatMoney(n, stats?.currency ?? 'EUR');
	const grams = (g: number | null | undefined) => (g == null ? '' : `${g < 10 ? g.toFixed(1) : Math.round(g)} g`);

	function open(r: PrintRecord) {
		selected = r;
		notes = r.notes ?? '';
		dialogOpen = true;
	}

	async function storeNotes() {
		if (!selected) return;
		savingNotes = true;
		const r = await saveNotes(selected, notes);
		savingNotes = false;
		if (r) {
			selected = r;
			items = items.map((i) => (i.id === r.id ? r : i));
			toast('success', 'Notes saved');
		}
	}

	async function remove(r: PrintRecord) {
		if (!(await deleteEntry(r))) return;
		dialogOpen = false;
		items = items.filter((i) => i.id !== r.id);
		void load();
	}

	async function runImport() {
		importing = true;
		const n = await importHistory(printerId);
		importing = false;
		if (n) void load();
	}

	function clear() {
		filter = { printer: '', result: '', from: '', to: '', q: '' };
	}
</script>

<div class="space-y-4">
	<!-- Filters, one row above everything they affect. -->
	<div class="flex flex-wrap items-center gap-2">
		{#if !printerId}
			<select class="input h-8 w-40 text-xs max-sm:w-auto max-sm:min-w-0 max-sm:flex-1" aria-label="Printer" bind:value={filter.printer}>
				<option value="">All printers</option>
				{#each printers.list as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
			</select>
		{/if}
		<select class="input h-8 w-32 text-xs max-sm:w-auto max-sm:min-w-0 max-sm:flex-1" aria-label="Result" bind:value={filter.result}>
			<option value="">Any result</option>
			<option value="success">Success</option>
			<option value="failed">Failed</option>
			<option value="cancelled">Cancelled</option>
			<option value="printing">Printing</option>
		</select>
		<div class="flex items-center gap-1.5 text-xs text-muted-foreground max-sm:w-full">
			<CalendarRange class="size-3.5 shrink-0" />
			<input type="date" class="input h-8 w-[8.5rem] text-xs max-sm:w-auto max-sm:min-w-0 max-sm:flex-1" aria-label="From" bind:value={filter.from} max={filter.to || undefined} />
			<span>–</span>
			<input type="date" class="input h-8 w-[8.5rem] text-xs max-sm:w-auto max-sm:min-w-0 max-sm:flex-1" aria-label="To" bind:value={filter.to} min={filter.from || undefined} />
		</div>
		<div class="relative max-sm:order-first max-sm:w-full">
			<Search class="absolute top-2 left-2.5 size-3.5 text-muted-foreground touch:top-3.5 touch:size-4" />
			<input class="input h-8 w-48 pl-8 text-xs max-sm:w-full touch:pl-9" placeholder="File, notes, person…" aria-label="Search history" bind:value={filter.q} />
		</div>
		{#if filtered}<button class="btn btn-ghost btn-sm" onclick={clear}>Clear</button>{/if}
		{#if loading}<LoaderCircle class="size-4 animate-spin text-muted-foreground" />{/if}
		<div class="ml-auto flex items-center gap-2">
			{#if isAdmin()}
				<button class="btn btn-ghost btn-sm" title="Import earlier prints from OctoPrint (PrintJobHistory plugin, or each file’s last print)" disabled={importing} onclick={runImport}>
					{#if importing}<LoaderCircle class="animate-spin" />{:else}<Import />{/if}Import
				</button>
			{/if}
			<a class="btn btn-secondary btn-sm" href={csvUrl(query)} download><Download />Export CSV</a>
		</div>
	</div>

	{#if error}
		<div class="card px-4 py-6 text-center text-xs text-danger">{error}</div>
	{:else if loaded && total === 0 && !filtered}
		<div class="card relative overflow-hidden px-6 py-14 text-center">
			<div class="dot-grid mask-fade pointer-events-none absolute inset-0"></div>
			<div class="relative mx-auto max-w-md">
				<div class="mx-auto grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><History class="size-5" /></div>
				<h2 class="mt-4 text-[15px] font-semibold tracking-tight">No prints yet</h2>
				<p class="mt-1.5 text-[13px] text-muted-foreground">
					Every print shows up here with its result, duration, filament and a picture of how it ended, whether or not anyone was watching.
				</p>
				{#if isAdmin()}
					<button class="btn btn-secondary btn-sm mt-4" disabled={importing} onclick={runImport}><Import />Import earlier prints from OctoPrint</button>
				{/if}
			</div>
		</div>
	{:else}
		{#if stats}
			<div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
				<div class="card px-4 py-3.5">
					<p class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Success rate</p>
					<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{pct(stats.successRate)}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">{stats.success} of {stats.prints} finished print{stats.prints === 1 ? '' : 's'}</p>
				</div>
				<div class="card px-4 py-3.5">
					<p class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Prints</p>
					<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{stats.prints}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">
						<span class={stats.failed ? 'text-danger' : ''}>{stats.failed} failed</span> · <span class={stats.cancelled ? 'text-warning' : ''}>{stats.cancelled} cancelled</span>
					</p>
				</div>
				<div class="card px-4 py-3.5">
					<p class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Print time</p>
					<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{stats.printTime ? formatDuration(stats.printTime) : '—'}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">{stats.prints ? `${formatDuration(stats.printTime / stats.prints)} on average` : 'nothing finished yet'}</p>
				</div>
				<div class="card px-4 py-3.5">
					<p class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Filament</p>
					<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{stats.filamentMm ? meters(stats.filamentMm) : '—'}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">from the slicer’s estimate × progress</p>
				</div>
				<div class="card px-4 py-3.5" data-testid="cost-total">
					<p class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Cost</p>
					<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{stats.costed ? money(stats.cost) : '—'}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">{stats.costed ? `${money(stats.cost / stats.costed)} per print` : 'set prices on the Filament page'}</p>
				</div>
			</div>

			{#if stats.perWeek.length}
				<div class="grid gap-3 {printerId ? '' : 'xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]'}">
					<div class="card px-4 pt-3.5 pb-3">
						<p class="mb-2 text-[13px] font-medium">Prints per week</p>
						<WeeklyChart weeks={stats.perWeek} />
					</div>
					{#if !printerId}
						<div class="card overflow-hidden">
							<p class="px-4 pt-3.5 pb-2 text-[13px] font-medium">By printer</p>
							<table class="w-full text-left text-xs">
								<thead class="text-[11px] text-muted-foreground">
									<tr class="border-y border-border bg-surface">
										<th class="px-4 py-1.5 font-medium">Printer</th>
										<th class="px-2 py-1.5 text-right font-medium">Prints</th>
										<th class="px-2 py-1.5 text-right font-medium">Success</th>
										<th class="px-2 py-1.5 text-right font-medium max-sm:hidden">Time</th>
										<th class="px-2 py-1.5 text-right font-medium">Filament</th>
										<th class="px-4 py-1.5 text-right font-medium">Cost</th>
									</tr>
								</thead>
								<tbody class="divide-y divide-border">
									{#each stats.perPrinter as p (p.printerId)}
										<tr>
											<td class="max-w-36 truncate px-4 py-2">{printers.list.find((x) => x.id === p.printerId)?.name ?? p.printerName}</td>
											<td class="px-2 py-2 text-right font-mono tabular-nums">{p.prints}</td>
											<td class="px-2 py-2 text-right font-mono tabular-nums">{pct(p.prints ? p.success / p.prints : null)}</td>
											<td class="px-2 py-2 text-right font-mono whitespace-nowrap tabular-nums max-sm:hidden">{formatDuration(p.printTime)}</td>
											<td class="px-2 py-2 text-right font-mono whitespace-nowrap tabular-nums">{meters(p.filamentMm)}</td>
											<td class="px-4 py-2 text-right font-mono whitespace-nowrap tabular-nums">{p.cost ? money(p.cost) : '—'}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</div>
			{/if}
		{/if}

		<div class="card overflow-hidden">
			{#if listLayout.current}
				<!-- Phones: a list; tapping a print opens it, with Print again, notes and Delete. -->
				<ul class="divide-y divide-border" data-testid="history-list">
					{#each items as r (r.id)}
						<li data-print={r.file} data-result={r.result}>
							<button class="flex w-full items-center gap-3 px-3 py-2.5 text-left active:bg-accent/40" onclick={() => open(r)}>
								{#if r.hasThumbnail}
									<img src={thumbnailUrl(r)} alt="" loading="lazy" class="h-12 w-20 shrink-0 rounded-md border border-border bg-muted object-cover" />
								{:else}
									<div class="grid h-12 w-20 shrink-0 place-items-center rounded-md border border-dashed border-border text-muted-foreground/60"><FileCode2 class="size-4" /></div>
								{/if}
								<span class="min-w-0 flex-1">
									<span class="line-clamp-2 text-[14px] leading-snug font-medium [overflow-wrap:anywhere]">{r.file}</span>
									<span class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
										<span class="badge {badge(r.result)}" title={r.reason ?? undefined}>{#if r.result === 'printing'}<span class="size-1.5 animate-pulse rounded-full bg-current"></span>{/if}{RESULT_LABEL[r.result]}</span>
										<span class="font-mono">{r.endedAt ? formatDuration(r.durationS) : ago(r.startedAt).replace(' ago', '')}</span>
										<span>{when(r.startedAt)}</span>
										{#if r.endedAt && r.cost != null}<span class="font-mono" data-cost={r.cost}>{money(r.cost)}</span>{/if}
										{#if !printerId}<span class="truncate">· {printerName(r)}</span>{/if}
									</span>
									{#if r.notes}<span class="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground"><NotebookPen class="size-3 shrink-0" /><span class="truncate">{r.notes}</span></span>{/if}
								</span>
							</button>
						</li>
					{:else}
						<li class="px-4 py-10 text-center text-xs text-muted-foreground">{loading || !loaded ? 'Loading…' : 'No prints match these filters.'}</li>
					{/each}
				</ul>
			{:else}
			<table class="w-full table-fixed text-left text-[13px]">
				<thead class="border-b border-border bg-surface text-[11px] text-muted-foreground">
					<tr>
						<th class="w-24 py-2 pl-4 font-medium"><span class="sr-only">Picture</span></th>
						<th class="px-3 py-2 font-medium">File</th>
						{#if !printerId}<th class="hidden w-36 px-3 py-2 font-medium md:table-cell">Printer</th>{/if}
						<th class="w-28 px-3 py-2 font-medium">Result</th>
						<th class="hidden w-36 px-3 py-2 font-medium lg:table-cell">Started</th>
						<th class="w-24 px-3 py-2 text-right font-medium">Duration</th>
						<th class="hidden w-24 px-3 py-2 text-right font-medium md:table-cell">Filament</th>
						<th class="hidden w-20 px-3 py-2 text-right font-medium md:table-cell">Cost</th>
						<th class="hidden w-36 px-3 py-2 font-medium xl:table-cell">By</th>
						<th class="w-24 px-3 py-2"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each items as r (r.id)}
						<tr class="group cursor-pointer hover:bg-accent/30" data-print={r.file} data-result={r.result} onclick={() => open(r)}>
							<td class="py-2 pl-4">
								{#if r.hasThumbnail}
									<img src={thumbnailUrl(r)} alt="" loading="lazy" class="h-9 w-16 rounded-md border border-border bg-muted object-cover" />
								{:else}
									<div class="grid h-9 w-16 place-items-center rounded-md border border-dashed border-border text-muted-foreground/60"><FileCode2 class="size-3.5" /></div>
								{/if}
							</td>
							<td class="px-3 py-2">
								<p class="truncate font-medium" title={r.path}>{r.file}</p>
								{#if r.notes}
									<p class="flex items-center gap-1 truncate text-[11px] text-muted-foreground"><NotebookPen class="size-3 shrink-0" /><span class="truncate">{r.notes}</span></p>
								{:else if r.path !== r.file || r.origin === 'sdcard'}
									<p class="truncate text-[11px] text-muted-foreground">{r.origin === 'sdcard' ? 'SD card · ' : ''}{r.path}</p>
								{/if}
							</td>
							{#if !printerId}<td class="hidden truncate px-3 py-2 text-xs md:table-cell">{printerName(r)}</td>{/if}
							<td class="px-3 py-2">
								<span class="badge {badge(r.result)}" title={r.reason ?? undefined}>
									{#if r.result === 'printing'}<span class="size-1.5 animate-pulse rounded-full bg-current"></span>{/if}{RESULT_LABEL[r.result]}
								</span>
								{#if r.source === 'import'}<span class="badge ml-1" title="Imported from OctoPrint">imported</span>{/if}
							</td>
							<td class="hidden px-3 py-2 text-xs whitespace-nowrap text-muted-foreground lg:table-cell" title={new Date(r.startedAt).toLocaleString()}>{when(r.startedAt)}</td>
							<td class="px-3 py-2 text-right font-mono text-xs whitespace-nowrap tabular-nums">{r.endedAt ? formatDuration(r.durationS) : ago(r.startedAt).replace(' ago', '')}</td>
							<td class="hidden px-3 py-2 text-right font-mono text-xs whitespace-nowrap tabular-nums md:table-cell" title={r.filamentG != null ? `${grams(r.filamentG)}${r.material ? ` ${r.material}` : ''}` : undefined}>{r.endedAt ? meters(r.filamentMm) : '—'}</td>
							<td class="hidden px-3 py-2 text-right font-mono text-xs whitespace-nowrap tabular-nums md:table-cell" data-cost={r.cost ?? ''}>{r.endedAt ? money(r.cost) : '—'}</td>
							<td class="hidden truncate px-3 py-2 text-xs text-muted-foreground xl:table-cell" title={who(r)}>{who(r)}</td>
							<td class="px-3 py-2 text-right whitespace-nowrap">
								{#if canControl(r) && r.endedAt}
									<button class="btn btn-ghost btn-icon btn-sm opacity-60 group-hover:opacity-100" title="Print again" aria-label="Print {r.file} again" onclick={(e) => (e.stopPropagation(), reprint(r, printerName(r)))}><RotateCcw /></button>
								{/if}
								{#if isAdmin()}
									<button class="btn btn-ghost btn-icon btn-sm opacity-60 group-hover:opacity-100 hover:text-danger" title="Delete entry" aria-label="Delete entry {r.file}" onclick={(e) => (e.stopPropagation(), remove(r))}><Trash2 /></button>
								{/if}
							</td>
						</tr>
					{:else}
						<tr><td colspan="10" class="px-4 py-10 text-center text-xs text-muted-foreground">{loading || !loaded ? 'Loading…' : 'No prints match these filters.'}</td></tr>
					{/each}
				</tbody>
			</table>
			{/if}
			{#if items.length}
				<div class="flex items-center justify-between border-t border-border bg-surface px-4 py-2 text-[11px] text-muted-foreground">
					<span>{items.length} of {total} print{total === 1 ? '' : 's'}</span>
					{#if items.length < total}<button class="btn btn-ghost btn-sm" disabled={loading} onclick={more}>Load older</button>{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<Dialog bind:open={dialogOpen} title={selected?.file ?? ''} description={selected ? `${printerName(selected)} · ${new Date(selected.startedAt).toLocaleString()}` : undefined} width="max-w-2xl">
	{#if selected}
		{@const r = selected}
		<div class="space-y-4">
			{#if r.hasThumbnail}
				<img src={thumbnailUrl(r)} alt="How {r.file} ended" class="aspect-video max-h-[38vh] w-full rounded-lg border border-border bg-black object-contain" />
			{:else}
				<div class="grid aspect-[3/1] w-full place-items-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
					<span class="flex items-center gap-1.5"><ImageOff class="size-4" />No picture (no webcam snapshot when it ended)</span>
				</div>
			{/if}
			<dl class="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[13px] sm:grid-cols-3">
				<div><dt class="text-[11px] text-muted-foreground">Result</dt><dd><span class="badge {badge(r.result)}">{RESULT_LABEL[r.result]}</span>{#if r.reason}<span class="ml-1.5 text-xs text-muted-foreground">{r.reason}</span>{/if}</dd></div>
				<div><dt class="text-[11px] text-muted-foreground">Duration</dt><dd class="font-mono text-xs">{formatDuration(r.durationS)}{#if r.estimatedS}<span class="text-muted-foreground"> / est. {formatDuration(r.estimatedS)}</span>{/if}</dd></div>
				<div><dt class="text-[11px] text-muted-foreground">Progress</dt><dd class="font-mono text-xs">{r.completion != null ? `${Math.round(r.completion)}%` : '—'}</dd></div>
				<div><dt class="text-[11px] text-muted-foreground">Started</dt><dd class="text-xs">{new Date(r.startedAt).toLocaleString()}</dd></div>
				<div><dt class="text-[11px] text-muted-foreground">Ended</dt><dd class="text-xs">{r.endedAt ? new Date(r.endedAt).toLocaleString() : 'still running'}</dd></div>
				<div><dt class="text-[11px] text-muted-foreground">Filament</dt><dd class="font-mono text-xs">{meters(r.filamentMm)}{#if r.filamentG != null}<span class="text-muted-foreground"> · {grams(r.filamentG)}{r.material ? ` ${r.material}` : ''}</span>{/if}</dd></div>
				<div>
					<dt class="text-[11px] text-muted-foreground">Cost</dt>
					<dd class="font-mono text-xs">{money(r.cost)}{#if r.cost != null}<span class="text-muted-foreground"> · filament {money(r.costFilament)}, power {money(r.costEnergy)}</span>{/if}</dd>
				</div>
				<div><dt class="text-[11px] text-muted-foreground">Started by</dt><dd class="text-xs">{who(r)}</dd></div>
				<div class="col-span-2"><dt class="text-[11px] text-muted-foreground">File</dt><dd class="truncate font-mono text-xs" title={r.path}>{r.origin === 'sdcard' ? 'SD: ' : ''}{r.path}</dd></div>
			</dl>
			<div>
				<label class="label" for="print-notes">Notes</label>
				{#if canControl(r) || isAdmin()}
					<textarea id="print-notes" class="input h-24 resize-y py-2 text-[13px]" placeholder="Filament, settings, what went wrong…" bind:value={notes} maxlength="4000"></textarea>
				{:else}
					<p class="text-[13px] whitespace-pre-wrap text-muted-foreground">{r.notes ?? 'No notes.'}</p>
				{/if}
			</div>
		</div>
	{/if}
	{#snippet footer()}
		{#if selected}
			{@const r = selected}
			{#if isAdmin()}<button class="btn btn-ghost btn-sm mr-auto text-danger hover:bg-danger/10 hover:text-danger" onclick={() => remove(r)}><Trash2 />Delete</button>{/if}
			{#if canControl(r) && r.endedAt}<button class="btn btn-secondary btn-sm" onclick={() => reprint(r, printerName(r))}><RotateCcw />Print again</button>{/if}
			{#if canControl(r) || isAdmin()}<button class="btn btn-primary btn-sm" disabled={savingNotes || notes === (r.notes ?? '')} onclick={storeNotes}>Save notes</button>{/if}
		{/if}
	{/snippet}
</Dialog>
