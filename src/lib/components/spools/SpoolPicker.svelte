<script lang="ts">
	import { CircleCheck, LoaderCircle, MapPin, RefreshCw, Search, X } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import SpoolSwatch from './SpoolSwatch.svelte';
	import { listSpools, setSpool, type SpoolList } from '#lib/client/spools.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import { fuzzyRank } from '#lib/fuzzy.ts';
	import { remainingFraction, remainingLabel, type PrinterSpools, type SpoolSummary } from '#lib/spools.ts';

	let {
		open = $bindable(false),
		printerId,
		printerName,
		tool,
		multiTool = false,
		current = null,
		lowThresholdG = 100,
		onpicked
	}: {
		open: boolean;
		printerId: string;
		printerName: string;
		tool: number;
		multiTool?: boolean;
		current?: number | null;
		lowThresholdG?: number;
		onpicked?: (s: PrinterSpools) => void;
	} = $props();

	let data = $state<SpoolList | null>(null);
	let error = $state('');
	let loading = $state(false);
	let q = $state('');
	let material = $state('');
	let saving = $state<number | null>(null);

	async function load(fresh = false) {
		loading = true;
		try {
			data = await listSpools(fresh);
			error = data.error ?? '';
		} catch (err) {
			error = errorMessage(err);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open) {
			q = '';
			void load();
		}
	});

	const materials = $derived([...new Set((data?.spools ?? []).map((s) => s.material).filter((m): m is string => !!m))].sort());
	const shown = $derived.by(() => {
		let list = (data?.spools ?? []).filter((s) => !material || s.material === material);
		const needle = q.trim();
		if (needle) {
			list = fuzzyRank(needle, list, (s) => [s.name, s.vendor ?? '', s.material ?? '', s.location ?? '', s.lotNr ?? '', `#${s.id}`]).map((x) => x.item);
		}
		return list;
	});

	async function pick(s: SpoolSummary | null) {
		saving = s?.id ?? 0;
		const r = await setSpool(printerId, tool, s?.id ?? null);
		saving = null;
		if (r) {
			onpicked?.(r);
			open = false;
		}
	}
</script>

<Dialog bind:open title="Choose a spool" description="{printerName}{multiTool ? ` · tool ${tool}` : ''} · from Spoolman" width="max-w-2xl">
	<div class="flex flex-wrap items-center gap-2">
		<div class="relative min-w-0 flex-1">
			<Search class="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
			<!-- svelte-ignore a11y_autofocus -->
			<input class="input pl-8" placeholder="Search name, vendor, material, location…" aria-label="Search spools" bind:value={q} autofocus />
		</div>
		<select class="input w-32" aria-label="Material" bind:value={material}>
			<option value="">All materials</option>
			{#each materials as m (m)}<option value={m}>{m}</option>{/each}
		</select>
		<button class="btn btn-ghost btn-icon" title="Reload from Spoolman" aria-label="Reload from Spoolman" disabled={loading} onclick={() => load(true)}>
			{#if loading}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}
		</button>
	</div>

	{#if error}
		<p class="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</p>
	{/if}

	<ul class="mt-3 max-h-[min(28rem,55vh)] divide-y divide-border overflow-y-auto rounded-xl border border-border" aria-label="Spools">
		{#each shown as s (s.id)}
			{@const frac = remainingFraction(s)}
			{@const used = data?.inUse[s.id]}
			{@const low = s.remainingWeight != null && s.remainingWeight < lowThresholdG}
			<li>
				<button
					class="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/60 disabled:opacity-60 {s.id === current ? 'bg-primary-soft' : ''}"
					data-spool={s.id}
					disabled={saving != null}
					onclick={() => pick(s)}
				>
					<SpoolSwatch spool={s} size="size-7" />
					<div class="min-w-0 flex-1">
						<p class="flex items-center gap-1.5 truncate text-[0.8125rem] font-medium">
							<span class="truncate">{s.name}</span>
							{#if s.material}<span class="badge shrink-0">{s.material}</span>{/if}
							{#if s.id === current}<CircleCheck class="size-4 shrink-0 text-primary" />{/if}
						</p>
						<p class="truncate text-[0.6875rem] text-muted-foreground">
							#{s.id}{s.vendor ? ` · ${s.vendor}` : ''}{#if s.location}<span class="ml-1 inline-flex items-center gap-0.5"><MapPin class="inline size-3" />{s.location}</span>{/if}
							{#if used && !(used.printerId === printerId && used.tool === tool)}<span class="text-warning"> · on {used.printerName}{multiTool ? ` T${used.tool}` : ''}</span>{/if}
						</p>
					</div>
					<div class="w-28 shrink-0 text-right">
						<p class="font-mono text-xs tabular-nums {low ? 'text-danger' : ''}">{remainingLabel(s)}</p>
						{#if frac != null}
							<div class="mt-1 h-1 overflow-hidden rounded-full bg-border"><div class="h-full rounded-full {low ? 'bg-danger' : 'bg-primary'}" style="width:{frac * 100}%"></div></div>
						{/if}
					</div>
				</button>
			</li>
		{:else}
			<li class="px-4 py-10 text-center text-xs text-muted-foreground">
				{loading ? 'Loading spools…' : data?.spools.length ? 'No spools match.' : 'Spoolman has no spools (or none that aren’t archived).'}
			</li>
		{/each}
	</ul>

	{#snippet footer()}
		{#if current != null}
			<button class="btn btn-ghost btn-sm mr-auto" disabled={saving != null} onclick={() => pick(null)}><X />No spool</button>
		{/if}
		<button class="btn btn-secondary btn-sm" onclick={() => (open = false)}>Close</button>
	{/snippet}
</Dialog>
