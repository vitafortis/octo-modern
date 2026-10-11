<script lang="ts">
	import { onMount } from 'svelte';
	import { Disc3, Repeat2, TriangleAlert } from '@lucide/svelte';
	import SpoolSwatch from '../spools/SpoolSwatch.svelte';
	import SpoolPicker from '../spools/SpoolPicker.svelte';
	import { printerSpools } from '#lib/client/spools.ts';
	import { isAdmin } from '#lib/client/state.svelte.ts';
	import { remainingFraction, remainingLabel, type PrinterSpools } from '#lib/spools.ts';
	import type { LivePrinter } from '#lib/client/live.svelte.ts';
	import type { Printer } from '#lib/types.ts';

	/** The active Spoolman spool per tool, on the printer dashboard. */
	let { printer, live, canControl, title }: { printer: Printer; live?: LivePrinter; canControl: boolean; title?: string } = $props();

	let data = $state<PrinterSpools | null>(null);
	let picking = $state<number | null>(null);

	async function load() {
		try {
			data = await printerSpools(printer.id);
		} catch {
			// The card stays as it was.
		}
	}

	onMount(() => {
		void load();
		// Remaining amounts change as prints report to Spoolman.
		const offs = live ? ['PrintDone', 'PrintFailed', 'PrintCancelled'].map((e) => live.on(e, () => setTimeout(load, 4000))) : [];
		const every = setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
		return () => {
			offs.forEach((off) => off());
			clearInterval(every);
		};
	});

	const tools = $derived(data ? Array.from({ length: data.tools }, (_, i) => i) : []);
	const byTool = $derived(new Map((data?.assignments ?? []).map((a) => [a.tool, a])));
</script>

{#if data && (data.configured || isAdmin())}
	<section class="card p-4 text-[13px]" data-testid="spool-card">
		<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Disc3 class="size-4 text-primary" />{title ?? 'Filament'}</h2>
		{#if !data.configured}
			<p class="mt-2 text-xs text-muted-foreground">Connect Spoolman to track which spool is loaded and how much is left. <a class="text-primary hover:underline" href="/filament">Set it up →</a></p>
		{:else}
			{#if data.error}<p class="mt-2 flex items-center gap-1.5 text-xs text-warning"><TriangleAlert class="size-3.5" />{data.error}</p>{/if}
			<ul class="mt-3 space-y-3">
				{#each tools as t (t)}
					{@const a = byTool.get(t)}
					{@const s = a?.spool}
					{@const frac = s ? remainingFraction(s) : null}
					{@const low = !!s && s.remainingWeight != null && s.remainingWeight < data.lowThresholdG}
					<li class="flex items-center gap-3" data-tool={t}>
						<SpoolSwatch spool={s ?? null} size="size-8" />
						<div class="min-w-0 flex-1">
							{#if a}
								<p class="truncate font-medium">{#if data.tools > 1}<span class="mr-1 font-mono text-[11px] text-muted-foreground">T{t}</span>{/if}{s?.name ?? `Spool #${a.spoolId}`}</p>
								<p class="truncate text-[11px] text-muted-foreground" title={s ? [s.material, s.vendor, s.location, `#${s.id}`].filter(Boolean).join(' · ') : undefined}>
									{#if s}{s.material ?? `#${s.id}`} · <span class="tabular-nums {low ? 'font-medium text-danger' : ''}">{remainingLabel(s)}</span>{#if low} left{/if}{:else}not found in Spoolman{/if}
								</p>
								{#if frac != null}
									<div class="mt-1 h-1 overflow-hidden rounded-full bg-border"><div class="h-full rounded-full {low ? 'bg-danger' : 'bg-primary'}" style="width:{frac * 100}%"></div></div>
								{/if}
							{:else}
								<p class="text-muted-foreground">{#if data.tools > 1}<span class="mr-1 font-mono text-[11px]">T{t}</span>{/if}No spool selected</p>
							{/if}
						</div>
						{#if canControl}
							<button class="btn btn-ghost btn-sm min-h-9 shrink-0" title="Choose the spool{data.tools > 1 ? ` for tool ${t}` : ''}" aria-label="Change spool{data.tools > 1 ? ` of tool ${t}` : ''}" onclick={() => (picking = t)}>
								<Repeat2 />{a ? 'Change' : 'Choose'}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
	{#if picking != null}
		<SpoolPicker
			bind:open={() => picking != null, (v) => !v && (picking = null)}
			printerId={printer.id}
			printerName={printer.name}
			tool={picking}
			multiTool={data.tools > 1}
			current={byTool.get(picking)?.spoolId ?? null}
			lowThresholdG={data.lowThresholdG}
			onpicked={(r) => (data = r)}
		/>
	{/if}
{/if}
