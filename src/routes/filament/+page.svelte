<script lang="ts">
	import { onMount } from 'svelte';
	import { Calculator, CircleCheck, CircleX, Coins, Disc3, LoaderCircle, Plug, Plus, RefreshCw, Trash2 } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import SpoolCard from '#lib/components/printer/SpoolCard.svelte';
	import { getCostSettings, getSpoolmanSettings, recalculateCosts, saveCostSettings, saveSpoolmanSettings, testSpoolman } from '#lib/client/spools.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import { isAdmin, printers, toast } from '#lib/client/state.svelte.ts';
	import type { CostSettings, SpoolmanSettings } from '#lib/spools.ts';

	// Spoolman connection (admins)
	let sm = $state<SpoolmanSettings | null>(null);
	let smForm = $state({ url: '', authHeader: '', authValue: '', lowThresholdG: 100, progressive: true });
	let smSaving = $state(false);
	let smTest = $state<{ ok: boolean; text: string } | null>(null);
	let cardsKey = $state(0);

	// Costs (admins)
	let costs = $state<CostSettings | null>(null);
	let costSaving = $state(false);

	onMount(async () => {
		if (!isAdmin()) return;
		try {
			const [s, c] = await Promise.all([getSpoolmanSettings(), getCostSettings()]);
			sm = s;
			smForm = { url: s.url ?? '', authHeader: s.authHeader ?? '', authValue: '', lowThresholdG: s.lowThresholdG, progressive: s.progressive };
			costs = c;
		} catch (err) {
			toast('error', 'Could not load the settings', errorMessage(err));
		}
	});

	async function saveSm(e?: SubmitEvent) {
		e?.preventDefault();
		smSaving = true;
		smTest = null;
		try {
			sm = await saveSpoolmanSettings({
				url: smForm.url.trim() || null,
				authHeader: smForm.authHeader.trim() || null,
				authValue: smForm.authValue || undefined,
				lowThresholdG: Number(smForm.lowThresholdG),
				progressive: smForm.progressive
			});
			smForm.authValue = '';
			smForm.url = sm.url ?? '';
			toast('success', 'Spoolman settings saved');
			if (sm.url) await runTest();
			cardsKey++;
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		} finally {
			smSaving = false;
		}
	}

	async function runTest() {
		try {
			const r = await testSpoolman();
			smTest = r.ok ? { ok: true, text: `Connected to Spoolman ${r.version ?? ''} · ${r.spools} spool${r.spools === 1 ? '' : 's'}` } : { ok: false, text: r.message ?? 'Failed' };
		} catch (err) {
			smTest = { ok: false, text: errorMessage(err) };
		}
	}

	async function saveCosts(e: SubmitEvent) {
		e.preventDefault();
		if (!costs) return;
		costSaving = true;
		try {
			const r = await saveCostSettings($state.snapshot(costs));
			const { costed, ...rest } = r;
			costs = rest;
			toast('success', 'Cost settings saved', costed ? `Costed ${costed} earlier print${costed === 1 ? '' : 's'}.` : undefined);
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		} finally {
			costSaving = false;
		}
	}

	const numOrNull = (v: unknown) => (v === '' || v == null ? null : Number(v));
</script>

<svelte:head><title>Filament · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Filament" description="Which spool is on which printer, what's left on it, and what each print costs." />
	<div class="space-y-6 px-4 pb-10 sm:px-8">
		<section>
			<h2 class="mb-2 flex items-center gap-2 text-[14px] font-semibold"><Disc3 class="size-4 text-primary" />Active spools</h2>
			{#key cardsKey}
				<div class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
					{#each printers.list as p (p.id)}
						<SpoolCard printer={p} canControl={!!p.access?.control} title={p.name} />
					{:else}
						<p class="text-xs text-muted-foreground">No printers yet.</p>
					{/each}
				</div>
			{/key}
			{#if !isAdmin()}
				<p class="mt-2 text-xs text-muted-foreground">Spools come from Spoolman; an admin connects it on this page.</p>
			{/if}
		</section>

		{#if isAdmin()}
			<div class="grid gap-4 xl:grid-cols-2">
				<section class="card p-5" id="spoolman">
					<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Plug class="size-4 text-primary" />Spoolman</h2>
					<p class="mt-1 text-xs text-muted-foreground">
						octo·modern reads your spools from <a class="text-primary hover:underline" href="https://github.com/Donkie/Spoolman" target="_blank" rel="noreferrer">Spoolman</a> and reports the filament each print uses. Before a print starts, it warns when the active spool won't last.
					</p>
					<form class="mt-4 grid gap-3 sm:grid-cols-2" onsubmit={saveSm}>
						<label class="sm:col-span-2"><span class="label">Address</span><input id="spoolman-url" class="input font-mono text-xs" placeholder="http://spoolman.local:7912" bind:value={smForm.url} /></label>
						<label><span class="label">Auth header (optional)</span><input id="spoolman-header" class="input font-mono text-xs" placeholder="Authorization" bind:value={smForm.authHeader} /></label>
						<label><span class="label">Header value</span><input id="spoolman-auth" class="input font-mono text-xs" type="password" autocomplete="off" placeholder={sm?.hasAuthValue ? '•••••• (stored; empty keeps it)' : 'Bearer …'} bind:value={smForm.authValue} disabled={!smForm.authHeader.trim()} /></label>
						<label><span class="label">Low-spool warning below</span>
							<span class="flex items-center gap-2"><input id="spoolman-low" class="input w-28" type="number" min="0" max="10000" step="1" bind:value={smForm.lowThresholdG} /><span class="text-xs text-muted-foreground">grams</span></span>
						</label>
						<div class="flex items-center gap-2 self-end pb-2 text-xs text-muted-foreground">
							<Switch label="Report while printing" bind:checked={smForm.progressive} />Report use while printing (every metre), not only at the end
						</div>
						<div class="flex flex-wrap items-center gap-2 sm:col-span-2">
							<button class="btn btn-primary btn-sm" disabled={smSaving}>{#if smSaving}<LoaderCircle class="animate-spin" />{/if}Save</button>
							{#if sm?.url}<button type="button" class="btn btn-secondary btn-sm" onclick={runTest}><RefreshCw />Test</button>{/if}
							{#if smTest}
								<span class="flex items-center gap-1.5 text-xs {smTest.ok ? 'text-success' : 'text-danger'}" data-testid="spoolman-test">
									{#if smTest.ok}<CircleCheck class="size-3.5" />{:else}<CircleX class="size-3.5" />{/if}{smTest.text}
								</span>
							{/if}
						</div>
					</form>
				</section>

				{#if costs}
					<section class="card p-5" id="costs">
						<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Coins class="size-4 text-primary" />Print costs</h2>
						<p class="mt-1 text-xs text-muted-foreground">Each finished print is costed as filament (by weight) plus electricity (print time × power draw). History, its stats and the CSV export show it.</p>
						<form class="mt-4 space-y-4" onsubmit={saveCosts}>
							<div class="grid gap-3 sm:grid-cols-3">
								<label><span class="label">Currency</span><input id="cost-currency" class="input font-mono uppercase" maxlength="3" bind:value={costs.currency} /></label>
								<label><span class="label">Electricity per kWh</span><input id="cost-kwh" class="input" type="number" min="0" step="any" placeholder="e.g. 0.30" bind:value={() => costs!.electricityPerKwh ?? '', (v) => (costs!.electricityPerKwh = numOrNull(v))} /></label>
								<label><span class="label">Default power draw (W)</span><input id="cost-watts" class="input" type="number" min="0" step="any" placeholder="e.g. 120" bind:value={() => costs!.defaultPowerW ?? '', (v) => (costs!.defaultPowerW = numOrNull(v))} /></label>
							</div>
							{#if printers.list.length}
								<div>
									<p class="label">Average draw per printer (W, empty uses the default)</p>
									<div class="grid gap-2 sm:grid-cols-2">
										{#each printers.list as p (p.id)}
											<label class="flex items-center gap-2 text-[13px]">
												<span class="min-w-0 flex-1 truncate">{p.name}</span>
												<input class="input w-28" type="number" min="0" step="any" aria-label="{p.name} power draw" placeholder={costs.defaultPowerW != null ? String(costs.defaultPowerW) : '—'}
													bind:value={() => costs!.printerPowerW[p.id] ?? '', (v) => { const n = numOrNull(v); if (n == null) delete costs!.printerPowerW[p.id]; else costs!.printerPowerW[p.id] = n; }} />
											</label>
										{/each}
									</div>
								</div>
							{/if}
							<div>
								<p class="label">Materials (used when a print's spool isn't known, and for its density)</p>
								<div class="overflow-x-auto rounded-xl border border-border">
									<table class="w-full text-left text-[13px]">
										<thead class="bg-surface text-[11px] text-muted-foreground">
											<tr><th class="px-3 py-1.5 font-medium">Material</th><th class="px-3 py-1.5 font-medium">Price / kg</th><th class="px-3 py-1.5 font-medium">Density g/cm³</th><th class="px-3 py-1.5 font-medium">Default</th><th></th></tr>
										</thead>
										<tbody class="divide-y divide-border">
											{#each costs.materials as m, i (i)}
												<tr>
													<td class="px-2 py-1"><input class="input h-8 w-24" aria-label="Material name" bind:value={m.name} /></td>
													<td class="px-2 py-1"><input class="input h-8 w-24" type="number" min="0" step="any" aria-label="{m.name} price per kg" bind:value={() => m.pricePerKg ?? '', (v) => (m.pricePerKg = numOrNull(v))} /></td>
													<td class="px-2 py-1"><input class="input h-8 w-20" type="number" min="0.5" max="5" step="0.01" aria-label="{m.name} density" bind:value={m.density} /></td>
													<td class="px-3 py-1"><input type="radio" name="default-material" class="size-4 accent-[var(--primary)]" aria-label="{m.name} is the default" checked={costs.defaultMaterial === m.name} onchange={() => (costs!.defaultMaterial = m.name)} /></td>
													<td class="px-2 py-1 text-right"><button type="button" class="btn btn-ghost btn-icon btn-sm hover:text-danger" aria-label="Remove {m.name}" disabled={costs.materials.length < 2} onclick={() => costs!.materials.splice(i, 1)}><Trash2 /></button></td>
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
								<button type="button" class="btn btn-ghost btn-sm mt-1" onclick={() => costs!.materials.push({ name: '', pricePerKg: null, density: 1.24 })}><Plus />Add material</button>
							</div>
							<div class="grid gap-3 sm:grid-cols-2">
								<label><span class="label">Filament diameter (mm)</span><input class="input w-28" type="number" min="1" max="5" step="0.01" bind:value={costs.diameter} /></label>
								<div class="flex items-center gap-2 self-end pb-2 text-xs text-muted-foreground"><Switch label="Use Spoolman prices" bind:checked={costs.useSpoolmanPrices} />Use the spool's price from Spoolman when it has one</div>
							</div>
							<div class="flex flex-wrap items-center gap-2">
								<button class="btn btn-primary btn-sm" disabled={costSaving}>{#if costSaving}<LoaderCircle class="animate-spin" />{/if}Save</button>
								<button type="button" class="btn btn-secondary btn-sm" onclick={recalculateCosts}><Calculator />Recalculate history</button>
							</div>
						</form>
					</section>
				{/if}
			</div>
		{/if}
	</div>
</div>
