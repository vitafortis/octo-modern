<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { ChartColumn, Download, History, LoaderCircle } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import HistoryTabs from '#lib/components/history/HistoryTabs.svelte';
	import StackedBars, { type Column, type Series } from '#lib/components/stats/StackedBars.svelte';
	import SpoolSwatch from '#lib/components/spools/SpoolSwatch.svelte';
	import { bucketLabel, bucketTitle, hours, loadStats, statsCsvUrl } from '#lib/client/stats.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import { formatDuration } from '#lib/printer.ts';
	import { formatMoney } from '#lib/spools.ts';
	import { RANGE_LABEL, STATS_RANGES, type StatsRange, type StatsReport } from '#lib/stats.ts';

	const initialRange = page.url.searchParams.get('range') as StatsRange;
	let range = $state<StatsRange>(STATS_RANGES.includes(initialRange) ? initialRange : '30d');
	let printer = $state(page.url.searchParams.get('printer') ?? '');
	let report = $state<StatsReport | null>(null);
	let loading = $state(false);
	let error = $state('');
	let controller: AbortController | undefined;

	async function load() {
		controller?.abort();
		const c = (controller = new AbortController());
		loading = true;
		try {
			report = await loadStats(range, printer, c.signal);
			error = '';
		} catch (err) {
			if (c.signal.aborted) return;
			error = errorMessage(err);
		} finally {
			if (controller === c) loading = false;
		}
	}

	$effect(() => {
		void [range, printer];
		untrack(() => {
			const q = new URLSearchParams();
			if (range !== '30d') q.set('range', range);
			if (printer) q.set('printer', printer);
			const s = q.toString();
			if (s !== page.url.searchParams.toString()) void goto(`/history/stats${s ? `?${s}` : ''}`, { replace: true, shallow: true });
			void load();
		});
	});

	// Series colours follow the printer (its place in the full list), never its rank; beyond four, "Other".
	const PALETTE = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
	const OTHER = 'var(--muted-foreground)';
	const colorOf = $derived.by(() => {
		const all = report?.printers ?? [];
		const fold = all.length > PALETTE.length;
		const m = new Map<string, number>();
		all.forEach((p, i) => m.set(p.id, fold && i >= PALETTE.length - 1 ? -1 : i));
		return m;
	});
	const color = (id: string) => {
		const i = colorOf.get(id) ?? -1;
		return i < 0 ? OTHER : PALETTE[i];
	};
	const shown = $derived((report?.printers ?? []).filter((p) => !printer || p.id === printer));
	const printerName = (id: string) => report?.printers.find((p) => p.id === id)?.name ?? 'Removed printer';

	/** Print time: one series per printer (four at most, the rest as "Other"). */
	const timeChart = $derived.by((): { series: Series[]; columns: Column[] } => {
		if (!report) return { series: [], columns: [] };
		const groups: { label: string; color: string; ids: string[] }[] = [];
		for (const p of shown) {
			const c = color(p.id);
			const g = c === OTHER ? groups.find((x) => x.color === OTHER) : undefined;
			if (g) g.ids.push(p.id);
			else groups.push({ label: c === OTHER ? 'Other printers' : p.name, color: c, ids: [p.id] });
		}
		// "Other" last.
		groups.sort((a, b) => Number(a.color === OTHER) - Number(b.color === OTHER));
		const g = report.granularity;
		return {
			series: groups.map((x) => ({ label: x.label, color: x.color })),
			columns: report.buckets.map((b) => ({
				key: b.key,
				label: bucketLabel(b.key, g),
				title: bucketTitle(b.key, g),
				values: groups.map((x) => x.ids.reduce((s, id) => s + (b.printTime[id] ?? 0), 0) / 3600)
			}))
		};
	});

	const OUTCOMES: Series[] = [
		{ label: 'Success', color: 'var(--success)' },
		{ label: 'Failed', color: 'var(--danger)' },
		{ label: 'Cancelled', color: 'var(--warning)' }
	];
	const outcomeColumns = $derived(
		(report?.buckets ?? []).map((b) => ({
			key: b.key,
			label: bucketLabel(b.key, report!.granularity),
			title: bucketTitle(b.key, report!.granularity),
			values: [b.success, b.failed, b.cancelled]
		}))
	);

	const t = $derived(report?.totals);
	const empty = $derived(!!report && report.totals.prints === 0);
	const pct = (v: number | null | undefined, digits = 0) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);
	const metres = (mm: number) => `${(mm / 1000).toLocaleString(undefined, { maximumFractionDigits: mm < 100_000 ? 1 : 0 })} m`;
	const grams = (g: number) => (g >= 1000 ? `${(g / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} kg` : `${Math.round(g)} g`);
	const hoursAxis = (v: number) => (v >= 10 || v === 0 ? String(Math.round(v)) : v.toFixed(1));
	const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	const fileLink = (f: { file: string; printerId: string }) => `/history?${new URLSearchParams({ q: f.file, ...(printer ? { printer } : {}) })}`;

	const REASONS: Record<string, string> = {
		error: 'Printer error',
		disconnected: 'Connection lost',
		'lost track': 'Lost track (octo·modern restarted mid-print)',
		'octoprint-stats': 'Counted as failed by OctoPrint (imported)',
		cancelled: 'Cancelled'
	};
	const reasonLabel = (r: { result: string; reason: string | null }) =>
		r.reason ? (REASONS[r.reason] ?? r.reason.charAt(0).toUpperCase() + r.reason.slice(1)) : r.result === 'cancelled' ? 'Cancelled, no reason given' : 'No reason recorded';
	const reasonTotal = $derived((report?.reasons ?? []).reduce((s, r) => s + r.count, 0));

	/** Every printer shown, idle ones at 0%. */
	const utilisation = $derived(
		shown
			.map((p) => {
				const u = report?.utilisation.find((x) => x.printerId === p.id);
				return { ...p, share: u?.share ?? 0, secs: u?.printSecs ?? 0 };
			})
			.filter((p) => !p.removed || p.secs > 0)
			.sort((a, b) => b.share - a.share)
	);
	const materialMax = $derived(Math.max(1, ...(report?.materials ?? []).map((m) => m.filamentG)));
	const spoolMax = $derived(Math.max(1, ...(report?.spools ?? []).map((s) => s.filamentMm)));
	const rangeLabel = $derived(range === 'all' ? 'all time' : `the last ${RANGE_LABEL[range]}`);
</script>

<svelte:head><title>Stats · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="History" description="How much your printers print, how often it works out, and what it uses.">
		{#snippet actions()}
			{#if report && !empty}
				<a class="btn btn-secondary btn-sm touch:h-11" href={statsCsvUrl(report, printer)} download data-testid="stats-csv"><Download />Export CSV</a>
			{/if}
		{/snippet}
	</PageHeader>
	<div class="page-x space-y-4 pb-10">
		<HistoryTabs active="stats" />
		<!-- Filters, one row above everything they affect. -->
		<div class="flex flex-wrap items-center gap-2">
			<div class="flex gap-1 rounded-xl border border-border bg-surface p-1 max-sm:w-full" role="radiogroup" aria-label="Time range">
				{#each STATS_RANGES as r (r)}
					<button
						role="radio"
						aria-checked={range === r}
						class="h-7 rounded-lg px-3 text-xs font-medium whitespace-nowrap transition-colors max-sm:flex-1 max-sm:px-1 touch:h-10 {range === r
							? 'bg-card text-foreground shadow-surface'
							: 'text-muted-foreground hover:text-foreground'}"
						onclick={() => (range = r)}>{RANGE_LABEL[r]}</button
					>
				{/each}
			</div>
			{#if (report?.printers.length ?? 0) > 1 || printer}
				<select class="input h-9 w-48 text-xs max-sm:w-full touch:h-11" aria-label="Printer" bind:value={printer}>
					<option value="">All printers</option>
					{#each report?.printers ?? [] as p (p.id)}<option value={p.id}>{p.name}{p.removed ? ' (removed)' : ''}</option>{/each}
				</select>
			{/if}
			{#if loading}<LoaderCircle class="size-4 animate-spin text-muted-foreground" aria-label="Loading" />{/if}
		</div>

		{#if error}
			<div class="card px-4 py-6 text-center text-xs text-danger">{error}</div>
		{:else if report && t && empty}
			<div class="card relative overflow-hidden px-6 py-14 text-center">
				<div class="dot-grid mask-fade pointer-events-none absolute inset-0"></div>
				<div class="relative mx-auto max-w-md">
					<div class="mx-auto grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><ChartColumn class="size-5" /></div>
					<h2 class="mt-4 text-[0.9375rem] font-semibold tracking-tight">No finished prints in {rangeLabel}</h2>
					<p class="mt-1.5 text-[0.8125rem] text-muted-foreground">Stats are built from the print history. Pick a longer range, or have a look at what’s there.</p>
					<a class="btn btn-secondary btn-sm mt-4" href="/history"><History />Open the history</a>
				</div>
			</div>
		{:else if report && t}
			<!-- Headline numbers. -->
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 {t.costed ? 'xl:grid-cols-6' : 'xl:grid-cols-5'}" data-testid="stats-tiles">
				<div class="card px-4 py-3.5">
					<p class="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Print time</p>
					<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{hours(t.printTime)}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">{report.rangeSecs ? `≈ ${hours((t.printTime / report.rangeSecs) * 86_400)} a day` : formatDuration(t.printTime)}</p>
				</div>
				<div class="card px-4 py-3.5">
					<p class="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Prints</p>
					<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{t.prints.toLocaleString()}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">
						<span class={t.failed ? 'text-danger' : ''}>{t.failed} failed</span> · <span class={t.cancelled ? 'text-warning' : ''}>{t.cancelled} cancelled</span>
					</p>
				</div>
				<div class="card px-4 py-3.5">
					<p class="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Success rate</p>
					<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{pct(t.successRate)}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">{t.success} of {t.prints} finished</p>
				</div>
				<div class="card px-4 py-3.5">
					<p class="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Filament</p>
					<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{metres(t.filamentMm)}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">≈ {grams(t.filamentG)}</p>
				</div>
				{#if t.costed}
					<div class="card px-4 py-3.5" data-testid="stats-cost">
						<p class="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Cost</p>
						<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{formatMoney(t.cost, t.currency)}</p>
						<p class="mt-0.5 text-xs text-muted-foreground">{formatMoney(t.cost / t.costed, t.currency)} per print</p>
					</div>
				{/if}
				<div class="card px-4 py-3.5">
					<p class="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Average print</p>
					<p class="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{formatDuration(t.avgPrintTime)}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">over finished prints</p>
				</div>
			</div>

			<!-- Over time. -->
			<div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
				<section class="card min-w-0 px-4 pt-3.5 pb-3" aria-labelledby="chart-time">
					<h2 id="chart-time" class="mb-2 text-[0.8125rem] font-medium">Print hours per {report.granularity}</h2>
					<StackedBars
						columns={timeChart.columns}
						series={timeChart.series}
						format={(v) => hours(v * 3600)}
						axisFormat={hoursAxis}
						label="Print hours per {report.granularity}, by printer"
						footer={(c) => `Total ${hours(c.values.reduce((s, v) => s + v, 0) * 3600)}`}
					/>
				</section>
				<section class="card min-w-0 px-4 pt-3.5 pb-3" aria-labelledby="chart-outcomes">
					<h2 id="chart-outcomes" class="mb-2 text-[0.8125rem] font-medium">Outcomes per {report.granularity}</h2>
					<StackedBars columns={outcomeColumns} series={OUTCOMES} format={(v) => String(v)} label="Prints per {report.granularity} by outcome" />
				</section>
			</div>

			<div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
				<!-- Utilisation. -->
				<section class="card min-w-0 overflow-hidden" aria-labelledby="util">
					<div class="px-4 pt-3.5 pb-2">
						<h2 id="util" class="text-[0.8125rem] font-medium">Utilisation</h2>
						<p class="text-xs text-muted-foreground">Share of {rangeLabel} each printer spent printing.</p>
					</div>
					<ul class="divide-y divide-border border-t border-border">
						{#each utilisation as u (u.id)}
							<li class="flex items-center gap-3 px-4 py-2.5 text-xs">
								<span class="size-2 shrink-0 rounded-full" style="background:{color(u.id)}" aria-hidden="true"></span>
								<span class="w-28 shrink-0 truncate sm:w-36">{u.name}</span>
								<div class="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="meter" aria-label="{u.name} utilisation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.share * 100)}>
									<div class="h-full rounded-full" style="width:{Math.min(100, u.share * 100)}%; background:{color(u.id)}"></div>
								</div>
								<span class="w-12 shrink-0 text-right font-mono tabular-nums">{pct(u.share, u.share < 0.1 ? 1 : 0)}</span>
								<span class="w-14 shrink-0 text-right font-mono text-muted-foreground tabular-nums max-sm:hidden">{hours(u.secs)}</span>
							</li>
						{/each}
					</ul>
				</section>

				<!-- Failure reasons. -->
				<section class="card min-w-0 overflow-hidden" aria-labelledby="reasons">
					<div class="px-4 pt-3.5 pb-2">
						<h2 id="reasons" class="text-[0.8125rem] font-medium">Why prints didn’t finish</h2>
						<p class="text-xs text-muted-foreground">{reasonTotal ? `${reasonTotal} failed or cancelled print${reasonTotal === 1 ? '' : 's'}` : 'Every print in this range succeeded.'}</p>
					</div>
					{#if report.reasons.length}
						<ul class="divide-y divide-border border-t border-border">
							{#each report.reasons as r (`${r.result}|${r.reason}`)}
								<li class="flex items-center gap-3 px-4 py-2.5 text-xs">
									<span class="badge {r.result === 'failed' ? 'badge-danger' : 'badge-warning'} w-20 shrink-0 justify-center">{r.result === 'failed' ? 'Failed' : 'Cancelled'}</span>
									<span class="min-w-0 flex-1 truncate" title={reasonLabel(r)}>{reasonLabel(r)}</span>
									<span class="w-8 shrink-0 text-right font-mono tabular-nums">{r.count}</span>
									<span class="w-10 shrink-0 text-right font-mono text-muted-foreground tabular-nums">{pct(r.count / reasonTotal)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			</div>

			<!-- Most-printed files. -->
			<section class="card overflow-hidden" aria-labelledby="files">
				<div class="flex items-baseline justify-between gap-3 px-4 pt-3.5 pb-2">
					<h2 id="files" class="text-[0.8125rem] font-medium">Most-printed files</h2>
					<a class="text-xs text-primary hover:underline" href="/history{printer ? `?printer=${encodeURIComponent(printer)}` : ''}">All prints</a>
				</div>
				<div class="overflow-x-auto">
					<table class="w-full text-left text-xs">
						<thead class="text-[0.6875rem] text-muted-foreground">
							<tr class="border-y border-border bg-surface">
								<th class="px-4 py-1.5 font-medium">File</th>
								<th class="px-2 py-1.5 text-right font-medium">Prints</th>
								<th class="px-2 py-1.5 text-right font-medium">Success</th>
								<th class="px-2 py-1.5 text-right font-medium max-sm:hidden">Avg time</th>
								<th class="px-4 py-1.5 text-right font-medium">Last printed</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-border">
							{#each report.files as f (f.path)}
								<tr>
									<td class="max-w-0 px-4 py-0 sm:w-1/2">
										<a class="flex min-h-10 flex-col justify-center py-1.5 hover:text-primary touch:min-h-11" href={fileLink(f)} title="{f.path} — show in the history">
											<span class="truncate font-medium">{f.file}</span>
											{#if !printer && report.printers.length > 1}<span class="truncate text-[0.6875rem] text-muted-foreground">last on {printerName(f.printerId)}</span>{/if}
										</a>
									</td>
									<td class="px-2 py-2 text-right font-mono tabular-nums">{f.prints}</td>
									<td class="px-2 py-2 text-right font-mono tabular-nums {f.successRate != null && f.successRate < 0.5 ? 'text-danger' : ''}">{pct(f.successRate)}</td>
									<td class="px-2 py-2 text-right font-mono whitespace-nowrap tabular-nums max-sm:hidden">{formatDuration(f.avgPrintTime)}</td>
									<td class="px-4 py-2 text-right whitespace-nowrap text-muted-foreground">{when(f.lastPrinted)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<!-- Filament. -->
			{#if report.materials.length || report.spools?.length}
				<div class="grid gap-3 {report.spools?.length ? 'lg:grid-cols-2' : ''}">
					{#if report.materials.length}
						<section class="card overflow-hidden" aria-labelledby="materials">
							<div class="px-4 pt-3.5 pb-2">
								<h2 id="materials" class="text-[0.8125rem] font-medium">Filament by material</h2>
								<p class="text-xs text-muted-foreground">Prints without a recorded material count as the default one.</p>
							</div>
							<ul class="divide-y divide-border border-t border-border">
								{#each report.materials as m (m.material)}
									<li class="flex items-center gap-3 px-4 py-2.5 text-xs">
										<span class="w-16 shrink-0 truncate font-medium">{m.material}</span>
										<div class="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
											<div class="h-full rounded-full bg-primary" style="width:{(m.filamentG / materialMax) * 100}%"></div>
										</div>
										<span class="w-16 shrink-0 text-right font-mono tabular-nums">{grams(m.filamentG)}</span>
										<span class="w-16 shrink-0 text-right font-mono text-muted-foreground tabular-nums max-sm:hidden">{metres(m.filamentMm)}</span>
										<span class="w-20 shrink-0 text-right whitespace-nowrap text-muted-foreground tabular-nums max-sm:w-auto">{m.prints} print{m.prints === 1 ? '' : 's'}</span>
									</li>
								{/each}
							</ul>
						</section>
					{/if}
					{#if report.spools?.length}
						<section class="card overflow-hidden" aria-labelledby="spools">
							<div class="px-4 pt-3.5 pb-2">
								<h2 id="spools" class="text-[0.8125rem] font-medium">Filament by spool</h2>
								<p class="text-xs text-muted-foreground">What was booked to each Spoolman spool.</p>
							</div>
							<ul class="divide-y divide-border border-t border-border">
								{#each report.spools as s (s.spoolId)}
									<li class="flex items-center gap-3 px-4 py-2.5 text-xs">
										<SpoolSwatch spool={{ color: s.color, colors: null }} size="size-4" />
										<span class="w-32 shrink-0 truncate sm:w-44" title={[s.vendor, s.name, s.material].filter(Boolean).join(' · ')}>
											{s.name ?? `Spool #${s.spoolId}`}{#if s.material}<span class="text-muted-foreground">{` · ${s.material}`}</span>{/if}
										</span>
										<div class="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
											<div class="h-full rounded-full bg-primary" style="width:{(s.filamentMm / spoolMax) * 100}%"></div>
										</div>
										<span class="w-16 shrink-0 text-right font-mono tabular-nums">{s.filamentG != null ? grams(s.filamentG) : metres(s.filamentMm)}</span>
									</li>
								{/each}
							</ul>
						</section>
					{/if}
				</div>
			{/if}
			<p class="text-[0.6875rem] text-muted-foreground">
				Buckets follow your time zone ({report.timeZone}). Prints count in the {report.granularity} they started; print time is OctoPrint’s, so pauses don’t count.
			</p>
		{:else}
			<div class="flex justify-center py-16"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
		{/if}
	</div>
</div>
