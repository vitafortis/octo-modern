<script lang="ts">
	import { onMount } from 'svelte';
	import { Flame, Power, Thermometer } from '@lucide/svelte';
	import TempChart from './TempChart.svelte';
	import { phone as chartH } from '#lib/client/viewport.svelte.ts';
	import { api } from '#lib/client/api.ts';
	import { setTargets } from '#lib/client/actions.ts';
	import type { LivePrinter } from '#lib/client/live.svelte.ts';
	import { formatTemp, heaterColor, heaterKeys, heaterLabel, isConnected } from '#lib/printer.ts';

	let { live, canControl }: { live: LivePrinter; canControl: boolean } = $props();

	type Profile = { name: string; extruder: number | null; bed: number | null; chamber: number | null };

	const RANGES = [
		{ label: '5 min', ms: 5 * 60_000 },
		{ label: '15 min', ms: 15 * 60_000 },
		{ label: '30 min', ms: 30 * 60_000 }
	];
	/** Chosen range; until someone picks one, the smallest that shows all the history there is. */
	let picked = $state<number | null>(null);
	const range = $derived.by(() => {
		if (picked) return picked;
		void live.historyVersion;
		const span = (live.history.newest()?.t ?? 0) - (live.history.oldest()?.t ?? 0);
		return (RANGES.find((r) => span <= r.ms) ?? RANGES[2]).ms;
	});
	let profiles = $state<Profile[]>([]);
	let drafts = $state<Record<string, string>>({});
	let busy = $state<string | null>(null);

	const s = $derived(live.snapshot);
	const heaters = $derived(heaterKeys(s.temps));
	const tools = $derived(heaters.filter((k) => k.startsWith('tool')).length);
	const samples = $derived(live.samples(range));
	const connected = $derived(isConnected(s.state));

	onMount(() => {
		api.get<{ profiles: Profile[] }>(`/api/printers/${live.id}/profiles`).then((r) => (profiles = r.profiles)).catch(() => {});
	});

	async function apply(targets: Record<string, number>, label: string) {
		busy = label;
		await setTargets(live.id, targets);
		busy = null;
	}

	async function setOne(k: string, e?: SubmitEvent) {
		e?.preventDefault();
		const v = Number(drafts[k]);
		if (drafts[k] === undefined || drafts[k] === '' || !Number.isFinite(v)) return;
		await apply({ [k]: v }, k);
		drafts[k] = '';
	}

	/** A preset sets every tool to its extruder value, plus bed and chamber where the printer has them. */
	function presetTargets(p: Profile, only?: string): Record<string, number> {
		const out: Record<string, number> = {};
		for (const k of heaters) {
			if (only && k !== only) continue;
			const v = k.startsWith('tool') ? p.extruder : k === 'bed' ? p.bed : k === 'chamber' ? p.chamber : null;
			if (v != null) out[k] = v;
		}
		return out;
	}

	const allOff = $derived(Object.fromEntries(heaters.map((k) => [k, 0])));
	const anyHeating = $derived(heaters.some((k) => (s.temps[k]?.target ?? 0) > 0));
</script>

<section class="card overflow-hidden">
	<div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
		<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Thermometer class="size-4 text-primary" />Temperatures</h2>
		<div class="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
			{#each heaters as k (k)}
				<span class="flex items-center gap-1.5"><span class="h-0.5 w-3 rounded-full" style="background:{heaterColor(k)}"></span>{heaterLabel(k, tools)}</span>
			{/each}
			{#if heaters.length}<span class="flex items-center gap-1.5"><span class="h-0 w-3 border-t border-dashed border-muted-foreground"></span>target</span>{/if}
		</div>
		<div class="ml-auto inline-flex rounded-lg border border-border bg-surface p-0.5">
			{#each RANGES as r (r.ms)}
				<button class="h-6 rounded-md px-2 text-[11px] touch:h-9 touch:px-2.5 touch:text-xs {range === r.ms ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}" onclick={() => (picked = r.ms)}>{r.label}</button>
			{/each}
		</div>
	</div>

	<div class="px-2 pt-3">
		<TempChart {samples} {heaters} windowMs={range} height={chartH.current ? 180 : 220} />
	</div>

	<div class="border-t border-border">
		{#if !heaters.length}
			<p class="px-4 py-4 text-xs text-muted-foreground">{connected ? 'No heater readings yet.' : 'Connect the printer to see and set temperatures.'}</p>
		{/if}
		{#each heaters as k (k)}
			{@const t = s.temps[k]}
			<form class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5 last:border-0" onsubmit={(e) => setOne(k, e)}>
				<span class="flex w-24 items-center gap-2 text-[13px] font-medium max-sm:w-auto max-sm:min-w-20"><span class="size-2 rounded-full" style="background:{heaterColor(k)}"></span>{heaterLabel(k, tools)}</span>
				<span class="w-20 font-mono text-[15px] font-semibold tabular-nums max-sm:w-auto">{formatTemp(t.actual)}</span>
				<span class="flex items-center gap-1 text-xs text-muted-foreground">
					{#if (t.target ?? 0) > 0}<Flame class="size-3.5 text-warning" />target <span class="font-mono text-foreground">{formatTemp(t.target)}</span>{:else}off{/if}
				</span>
				{#if canControl}
					<!-- Phones: its own full-width row under the reading. -->
					<div class="ml-auto flex items-center gap-1.5 max-sm:w-full">
						<input
							class="input h-7 w-20 text-right font-mono text-xs max-sm:min-w-0 max-sm:flex-1"
							type="number"
							min="0"
							max={k.startsWith('tool') ? 450 : k === 'bed' ? 200 : 120}
							step="1"
							placeholder={t.target ? String(t.target) : '0'}
							aria-label="{heaterLabel(k, tools)} target"
							bind:value={drafts[k]}
							disabled={!connected}
						/>
						<button class="btn btn-secondary btn-sm" disabled={!connected || busy === k || !drafts[k]}>Set</button>
						{#if profiles.length}
							<select
								class="input h-7 w-28 text-xs max-sm:w-auto max-sm:max-w-[40%] max-sm:flex-1"
								aria-label="{heaterLabel(k, tools)} preset"
								disabled={!connected}
								onchange={(e) => {
									const sel = e.currentTarget as HTMLSelectElement;
									const p = profiles.find((x) => x.name === sel.value);
									sel.value = '';
									if (p) apply(presetTargets(p, k), k);
								}}
							>
								<option value="">Preset…</option>
								{#each profiles as p (p.name)}
									{@const v = k.startsWith('tool') ? p.extruder : k === 'bed' ? p.bed : p.chamber}
									{#if v != null}<option value={p.name}>{p.name} · {v}°</option>{/if}
								{/each}
							</select>
						{/if}
						<button type="button" class="btn btn-ghost btn-icon btn-sm" title="Turn off" disabled={!connected || !t.target} onclick={() => apply({ [k]: 0 }, k)}><Power /></button>
					</div>
				{/if}
			</form>
		{/each}
	</div>

	{#if canControl && heaters.length}
		<div class="flex flex-wrap items-center gap-1.5 border-t border-border bg-surface px-4 py-2.5">
			<span class="mr-1 text-[11px] text-muted-foreground">Presets</span>
			{#each profiles as p (p.name)}
				<button class="btn btn-secondary btn-sm" disabled={!connected || !!busy} onclick={() => apply(presetTargets(p), p.name)} title="Hotend {p.extruder ?? '—'}° · bed {p.bed ?? '—'}°">{p.name}</button>
			{:else}
				<span class="text-[11px] text-muted-foreground">none in OctoPrint (Settings → Temperatures)</span>
			{/each}
			<button class="btn btn-ghost btn-sm ml-auto" disabled={!connected || !anyHeating || !!busy} onclick={() => apply(allOff, 'off')}><Power />All off</button>
		</div>
	{/if}
</section>
