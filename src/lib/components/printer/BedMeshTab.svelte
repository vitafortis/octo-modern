<script lang="ts">
	/**
	 * Care › Bed mesh (printers with the Bed Visualizer plugin): the current mesh as a heatmap and
	 * a 3D surface with its range and flatness, "Update mesh" (operators, asks first), the mesh
	 * history with a difference map between any two, a flatness trend, and drift alerts.
	 */
	import { onMount } from 'svelte';
	import { ArrowRight, BellRing, Grid3x3, LoaderCircle, RefreshCw, ScanLine, Star, Trash2, TriangleAlert } from '@lucide/svelte';
	import MeshHeatmap from '../bedmesh/MeshHeatmap.svelte';
	import MeshSurface from '../bedmesh/MeshSurface.svelte';
	import FlatnessTrend from '../bedmesh/FlatnessTrend.svelte';
	import Switch from '../Switch.svelte';
	import { act } from '#lib/client/actions.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { bedMesh, type BedMeshData } from '#lib/client/bedmesh.svelte.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { BLV_PLUGIN, diffMesh, fmtZ, maxAbs, meshStats, parsePluginMessage, type MeshSnapshot, type MeshSummary } from '#lib/bedmesh.ts';
	import { isConnected, jobActive } from '#lib/printer.ts';
	import type { TabProps } from './tabs.ts';

	let { printer, live, canControl }: TabProps = $props();

	let data = $state<BedMeshData | null>(null);
	let error = $state('');
	let refreshing = $state(false);
	/** The mesh shown at the top (null: the latest). */
	let viewId = $state<number | null>(null);
	let view = $state<MeshSnapshot | null>(null);
	let view3d = $state(true);
	// Compare
	let fromId = $state<number | null>(null);
	let toId = $state<number | null>(null);
	let from = $state<MeshSnapshot | null>(null);
	let to = $state<MeshSnapshot | null>(null);
	// Drift form
	let form = $state({ enabled: false, maxFlatness: '' as string | number, maxChange: '' as string | number, referenceId: null as number | null });
	let saving = $state(false);

	const cache = new Map<number, MeshSnapshot>();
	async function meshById(id: number): Promise<MeshSnapshot> {
		const hit = cache.get(id);
		if (hit) return hit;
		const m = await bedMesh.mesh(printer.id, id);
		cache.set(id, m);
		return m;
	}

	async function load(refresh = false) {
		try {
			const d = await bedMesh.load(printer.id, refresh);
			if (d.latest) cache.set(d.latest.id, d.latest);
			const first = !data;
			data = d;
			error = '';
			if (first) {
				form = { enabled: d.settings.enabled, maxFlatness: d.settings.maxFlatness ?? '', maxChange: d.settings.maxChange ?? '', referenceId: d.settings.referenceId };
			}
			// Keep the picks when they still exist.
			const ids = new Set(d.history.map((m) => m.id));
			if (viewId != null && !ids.has(viewId)) viewId = null;
			if (fromId == null || !ids.has(fromId)) fromId = d.referenceId;
			if (toId == null || !ids.has(toId) || (first && d.latest)) toId = d.latest?.id ?? null;
		} catch (err) {
			error = errorMessage(err);
		}
	}

	async function refresh() {
		refreshing = true;
		await load(true);
		refreshing = false;
	}

	onMount(() => {
		void load();
		// The plugin's push messages: progress, the new mesh, errors.
		const off = live.on(`plugin:${BLV_PLUGIN}`, (payload) => {
			const msg = parsePluginMessage(payload);
			if (!msg || !data) return;
			if (msg.kind === 'processing' && data.update && !data.update.endedAt) data.update = { ...data.update, phase: 'probing' };
			if (msg.kind === 'mesh' || msg.kind === 'error') setTimeout(() => void load(), 300);
		});
		return off;
	});

	const running = $derived(!!data?.update && !data.update.endedAt);
	// While a probe run is going, check every few seconds (servers without push, and the end of it).
	$effect(() => {
		if (!running) return;
		const t = setInterval(() => void load(), 3000);
		return () => clearInterval(t);
	});
	// Announce how a probe run ended, when this page saw it running.
	let watching = $state(false);
	$effect(() => {
		const u = data?.update;
		if (!u) return;
		if (!u.endedAt) {
			watching = true;
			return;
		}
		if (!watching) return;
		watching = false;
		if (u.phase === 'done') {
			toast('success', 'New bed mesh', `${printer.name} · flatness ${fmtZ(data?.latest?.flatness ?? null, 3, false)} mm`);
			viewId = null;
			if (u.meshId != null) toId = u.meshId;
		} else toast('error', u.phase === 'timeout' ? 'Mesh update timed out' : 'Mesh update failed', u.message ?? undefined);
	});

	// The shown mesh.
	$effect(() => {
		const id = viewId;
		const latest = data?.latest ?? null;
		if (id == null || id === latest?.id) {
			view = latest;
			return;
		}
		meshById(id).then((m) => viewId === id && (view = m), (err) => toast('error', 'Could not load that mesh', errorMessage(err)));
	});
	$effect(() => {
		const a = fromId;
		const b = toId;
		if (a == null || b == null) {
			from = to = null;
			return;
		}
		Promise.all([meshById(a), meshById(b)]).then(
			([x, y]) => {
				if (fromId === a && toId === b) [from, to] = [x, y];
			},
			(err) => toast('error', 'Could not load the meshes to compare', errorMessage(err))
		);
	});

	const stats = $derived(view ? meshStats(view.mesh) : null);
	/** Colour range: symmetric around the mean, covering the farther extreme. */
	const span = $derived(stats ? Math.max(0.02, Math.max(stats.max - stats.mean, stats.mean - stats.min)) : 0.1);
	const diff = $derived(from && to ? diffMesh(from.mesh, to.mesh) : null);
	const diffMax = $derived(diff ? maxAbs(diff) : null);
	const diffStats = $derived(diff ? meshStats(diff) : null);

	const s = $derived(live.snapshot);
	const printing = $derived(jobActive(s.state));
	const connected = $derived(isConnected(s.state));
	const canUpdate = $derived(canControl && !!data?.plugin.configured && !printing && connected && !running);
	const updateHint = $derived(
		!data?.plugin.configured
			? 'Set the probe G-code in OctoPrint → Settings → Bed Visualizer first'
			: printing
				? 'Not while a print is running'
				: !connected
					? 'Connect the printer first'
					: running
						? 'Probing…'
						: 'Home and probe the bed now'
	);

	async function update() {
		const ok = await act(bedMesh.updateUrl(printer.id), { action: 'update' }, { failed: 'Could not start the mesh update' });
		if (ok) await load();
	}

	async function setReference(m: MeshSummary) {
		try {
			const r = await bedMesh.saveSettings(printer.id, { referenceId: m.id });
			form.referenceId = r.settings.referenceId;
			fromId = m.id;
			toast('success', 'Reference mesh set', when(m.createdAt));
			await load();
		} catch (err) {
			toast('error', 'Could not set the reference', errorMessage(err));
		}
	}

	async function remove(m: MeshSummary) {
		const ok = await confirmAction({ title: 'Delete this mesh?', body: 'It disappears from the history, the trend and comparisons. OctoPrint keeps its own copy of the latest mesh.', detail: `${when(m.createdAt)} · flatness ${m.flatness.toFixed(3)} mm`, confirmLabel: 'Delete', danger: true });
		if (!ok) return;
		try {
			await bedMesh.remove(printer.id, m.id);
			cache.delete(m.id);
			await load();
		} catch (err) {
			toast('error', 'Could not delete the mesh', errorMessage(err));
		}
	}

	async function saveDrift(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		try {
			const num = (v: string | number) => (v === '' || v === null ? null : Number(v));
			const r = await bedMesh.saveSettings(printer.id, { enabled: form.enabled, maxFlatness: num(form.maxFlatness), maxChange: num(form.maxChange), referenceId: form.referenceId });
			if (data) data = { ...data, settings: r.settings, referenceId: r.referenceId };
			toast('success', form.enabled ? 'Drift alerts on' : 'Drift alerts saved');
		} catch (err) {
			toast('error', 'Could not save the drift alerts', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const SOURCE: Record<string, string> = { octoprint: 'from OctoPrint', push: 'live', update: 'probed here' };
	const coord = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
</script>

{#snippet stat(label: string, value: string, sub: string | null, testid: string, tone = '')}
	<div class="card px-4 py-3" data-testid={testid}>
		<p class="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
		<p class="mt-1 font-mono text-xl font-semibold tracking-tight tabular-nums {tone}">{value}<span class="ml-1 text-xs font-normal text-muted-foreground">mm</span></p>
		{#if sub}<p class="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">{sub}</p>{/if}
	</div>
{/snippet}

<div class="mx-auto max-w-6xl space-y-5" data-testid="bed-tab">
	{#if error}
		<div class="card px-4 py-6 text-center text-xs text-danger">{error}</div>
	{:else if data}
		<!-- Header: what's shown, and Update -->
		<div class="flex flex-wrap items-center gap-3">
			<div class="min-w-0 flex-1">
				<h2 class="text-[0.9375rem] font-semibold tracking-tight">Bed mesh</h2>
				<p class="text-xs text-muted-foreground">
					{#if view}
						{view.id === data.latest?.id ? 'Latest' : 'Mesh of'} {when(view.createdAt)} · {view.cols} × {view.rows} points · {SOURCE[view.source] ?? view.source}
						{#if view.id === data.referenceId}· <span class="text-foreground">reference</span>{/if}
					{:else}
						From the Bed Visualizer plugin
					{/if}
				</p>
			</div>
			<button class="btn btn-ghost btn-icon btn-sm" title="Check OctoPrint for a newer mesh" aria-label="Check OctoPrint for a newer mesh" disabled={refreshing} onclick={refresh}><RefreshCw class={refreshing ? 'animate-spin' : ''} /></button>
			{#if canControl}
				<button class="btn btn-primary btn-sm" disabled={!canUpdate} title={updateHint} onclick={update} data-testid="mesh-update">
					{#if running}<LoaderCircle class="animate-spin" />Probing…{:else}<ScanLine />Update mesh{/if}
				</button>
			{/if}
		</div>

		{#if running && data.update}
			<div class="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary-soft px-4 py-3 text-[0.8125rem]" data-testid="mesh-progress" role="status">
				<LoaderCircle class="size-4 shrink-0 animate-spin text-primary" />
				<div class="min-w-0 flex-1">
					<p class="font-medium">{data.update.phase === 'sending' ? 'Sending the probe G-code…' : 'Probing the bed…'}</p>
					<p class="text-xs text-muted-foreground">Started {ago(data.update.startedAt)}{data.update.startedBy ? ` by ${data.update.startedBy}` : ''}. The new mesh shows here when the plugin reports it.</p>
				</div>
				<div class="h-1 w-24 overflow-hidden rounded-full bg-border max-sm:hidden"><div class="h-full w-1/3 animate-[mesh-indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-primary"></div></div>
			</div>
		{:else if data.update && data.update.endedAt && data.update.phase !== 'done' && Date.now() - Date.parse(data.update.endedAt) < 3600_000}
			<div class="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-[0.8125rem]" data-testid="mesh-update-error">
				<TriangleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
				<div>
					<p class="font-medium">{data.update.phase === 'timeout' ? 'The last mesh update timed out' : 'The last mesh update failed'}</p>
					{#if data.update.message}<p class="mt-0.5 text-xs text-muted-foreground">{data.update.message}</p>{/if}
				</div>
			</div>
		{/if}

		{#if !data.plugin.configured}
			<p class="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-muted-foreground" data-testid="mesh-not-configured">
				<span class="font-medium text-foreground">The plugin has no probe G-code.</span> Set it in OctoPrint → Settings → Bed Visualizer → Collection (for example <code class="font-mono">G28</code> and <code class="font-mono">G29 T</code> on Marlin) to update the mesh from here.
			</p>
		{/if}

		{#if !view || !stats}
			<div class="card relative overflow-hidden px-6 py-10 text-center" data-testid="mesh-empty">
				<div class="dot-grid mask-fade pointer-events-none absolute inset-0"></div>
				<div class="relative mx-auto max-w-md">
					<div class="mx-auto grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><Grid3x3 class="size-5" /></div>
					<h3 class="mt-4 text-[0.9375rem] font-semibold tracking-tight">No bed mesh yet</h3>
					<p class="mt-1.5 text-[0.8125rem] text-muted-foreground">Probe the bed to see how flat it is. Meshes probed from OctoPrint show up here too.</p>
					{#if canControl}
						<button class="btn btn-primary btn-sm mt-4" disabled={!canUpdate} title={updateHint} onclick={update}><ScanLine />Update mesh</button>
					{/if}
				</div>
			</div>
		{:else}
			<!-- Stats -->
			<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
				{@render stat('Flatness', fmtZ(stats.flatness, 3, false), 'max − min', 'mesh-flatness', view.drift ? 'text-warning' : '')}
				{@render stat('Lowest', fmtZ(stats.min), `at X ${coord(stats.minAt.x)} · Y ${coord(stats.minAt.y)}`, 'mesh-min')}
				{@render stat('Highest', fmtZ(stats.max), `at X ${coord(stats.maxAt.x)} · Y ${coord(stats.maxAt.y)}`, 'mesh-max')}
				{@render stat('Mean', fmtZ(stats.mean), `${stats.points} points${stats.missing ? ` · ${stats.missing} missing` : ''}`, 'mesh-mean')}
			</div>
			{#if view.drift}
				<p class="flex items-center gap-2 text-xs text-warning" data-testid="mesh-drift-flag"><TriangleAlert class="size-3.5" />This mesh broke a drift limit{view.change != null ? ` (moved up to ${view.change.toFixed(3)} mm from the reference)` : ''}.</p>
			{/if}

			<!-- Heatmap + 3D -->
			<div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
				<section class="card p-4">
					<h3 class="mb-3 text-[0.8125rem] font-semibold tracking-tight">Heatmap <span class="font-normal text-muted-foreground">· back of the bed at the top</span></h3>
					<MeshHeatmap mesh={view.mesh} center={stats.mean} range={span} label="Bed mesh heights in mm" />
				</section>
				<section class="card p-4">
					<div class="mb-3 flex items-center gap-2">
						<h3 class="flex-1 text-[0.8125rem] font-semibold tracking-tight">Surface</h3>
						<label class="flex items-center gap-2 text-xs text-muted-foreground">3D <Switch bind:checked={view3d} label="Show the 3D surface" /></label>
					</div>
					{#if view3d}
						<MeshSurface mesh={view.mesh} center={stats.mean} range={span} label="Bed mesh surface" />
					{:else}
						<p class="py-10 text-center text-xs text-muted-foreground">3D view off.</p>
					{/if}
				</section>
			</div>
		{/if}

		{#if data.history.length}
			<div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
				<!-- Compare -->
				<section class="card p-4" data-testid="mesh-compare">
					<h3 class="text-[0.8125rem] font-semibold tracking-tight">Compare</h3>
					<p class="mt-0.5 text-xs text-muted-foreground">How the bed moved between two meshes (later − earlier).</p>
					<div class="mt-3 flex flex-wrap items-end gap-2">
						<label class="min-w-0 flex-1 basis-40"><span class="label">From</span>
							<select class="input" bind:value={fromId} data-testid="compare-from">
								{#each data.history as m (m.id)}<option value={m.id}>{when(m.createdAt)}{m.id === data.referenceId ? ' (reference)' : ''}</option>{/each}
							</select>
						</label>
						<ArrowRight class="mb-2.5 size-4 text-muted-foreground max-sm:hidden" />
						<label class="min-w-0 flex-1 basis-40"><span class="label">To</span>
							<select class="input" bind:value={toId} data-testid="compare-to">
								{#each data.history as m (m.id)}<option value={m.id}>{when(m.createdAt)}{m.id === data.latest?.id ? ' (latest)' : ''}</option>{/each}
							</select>
						</label>
					</div>
					{#if diff && diffStats && from && to}
						{#if from.id === to.id}
							<p class="mt-4 text-xs text-muted-foreground">Pick two different meshes.</p>
						{:else}
							<div class="mt-3 grid grid-cols-3 gap-2 text-center">
								<div class="rounded-lg bg-muted px-2 py-2"><p class="text-[0.6875rem] text-muted-foreground">Largest change</p><p class="font-mono text-sm font-semibold tabular-nums" data-testid="diff-max">{fmtZ(diffMax, 3, false)} mm</p></div>
								<div class="rounded-lg bg-muted px-2 py-2"><p class="text-[0.6875rem] text-muted-foreground">Mean shift</p><p class="font-mono text-sm font-semibold tabular-nums">{fmtZ(diffStats.mean)} mm</p></div>
								<div class="rounded-lg bg-muted px-2 py-2"><p class="text-[0.6875rem] text-muted-foreground">Flatness</p><p class="font-mono text-sm font-semibold tabular-nums">{from.flatness.toFixed(3)} → {to.flatness.toFixed(3)}</p></div>
							</div>
							{#if from.rows !== to.rows || from.cols !== to.cols}<p class="mt-2 text-[0.6875rem] text-muted-foreground">Different grids ({from.cols}×{from.rows} and {to.cols}×{to.rows}): the earlier one is interpolated.</p>{/if}
							<div class="mt-3"><MeshHeatmap mesh={diff} center={0} range={Math.max(0.02, diffMax ?? 0)} label="Difference between the two meshes in mm" testid="mesh-diff" /></div>
						{/if}
					{/if}
				</section>

				<div class="space-y-5">
					<!-- Trend -->
					<section class="card p-4">
						<h3 class="text-[0.8125rem] font-semibold tracking-tight">Flatness over time</h3>
						<p class="mt-0.5 mb-2 text-xs text-muted-foreground">{data.history.length} mesh{data.history.length === 1 ? '' : 'es'} since {when(data.history.at(-1)!.createdAt)}</p>
						<FlatnessTrend meshes={data.history} limit={data.settings.maxFlatness} />
					</section>

					<!-- Drift alerts -->
					<section class="card p-4" data-testid="mesh-drift">
						<div class="flex items-center gap-2">
							<BellRing class="size-4 text-muted-foreground" />
							<h3 class="flex-1 text-[0.8125rem] font-semibold tracking-tight">Drift alerts</h3>
							{#if canControl}<Switch bind:checked={form.enabled} label="Drift alerts" />{:else}<span class="badge {data.settings.enabled ? 'badge-primary' : ''}">{data.settings.enabled ? 'On' : 'Off'}</span>{/if}
						</div>
						<p class="mt-1 text-xs text-muted-foreground">When a new mesh arrives, notify (“Bed mesh drift” in Notifications rules) if it breaks a limit.</p>
						{#if canControl}
							<form class="mt-3 grid gap-3 sm:grid-cols-2" onsubmit={saveDrift}>
								<label><span class="label">Flatness over (mm)</span><input class="input font-mono" type="number" min="0.001" max="10" step="any" placeholder="off" bind:value={form.maxFlatness} data-testid="drift-flatness" /></label>
								<label><span class="label">Any point moved over (mm)</span><input class="input font-mono" type="number" min="0.001" max="10" step="any" placeholder="off" bind:value={form.maxChange} data-testid="drift-change" /></label>
								<label class="sm:col-span-2"><span class="label">Reference mesh</span>
									<select class="input" bind:value={form.referenceId}>
										<option value={null}>The oldest kept</option>
										{#each data.history as m (m.id)}<option value={m.id}>{when(m.createdAt)} · {m.flatness.toFixed(3)} mm</option>{/each}
									</select>
								</label>
								<div class="sm:col-span-2 flex justify-end"><button class="btn btn-primary btn-sm" disabled={saving} data-testid="drift-save">Save</button></div>
							</form>
						{:else}
							<p class="mt-2 text-xs text-muted-foreground">Flatness over {data.settings.maxFlatness ?? '—'} mm · change over {data.settings.maxChange ?? '—'} mm</p>
						{/if}
					</section>
				</div>
			</div>

			<!-- History -->
			<section class="card overflow-hidden" data-testid="mesh-history">
				<h3 class="border-b border-border px-4 py-3 text-[0.8125rem] font-semibold tracking-tight">History</h3>
				<ul class="max-h-96 divide-y divide-border overflow-y-auto">
					{#each data.history as m (m.id)}
						{@const shown = (viewId ?? data.latest?.id) === m.id}
						<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 {shown ? 'bg-primary-soft' : ''}" data-mesh={m.id}>
							<button class="min-h-11 min-w-0 flex-1 basis-52 text-left" onclick={() => (viewId = m.id === data?.latest?.id ? null : m.id)} aria-current={shown || undefined}>
								<span class="flex flex-wrap items-center gap-2 text-[0.8125rem] font-medium">
									{when(m.createdAt)}
									{#if m.id === data.referenceId}<span class="badge badge-primary"><Star class="size-3" />reference</span>{/if}
									{#if m.drift}<span class="badge badge-warning"><span class="size-1.5 rounded-full bg-current"></span>drift</span>{/if}
								</span>
								<span class="block text-[0.6875rem] text-muted-foreground">{m.cols} × {m.rows} · {SOURCE[m.source] ?? m.source}{m.lastSeenAt !== m.createdAt ? ` · last seen ${ago(m.lastSeenAt)}` : ''}</span>
							</button>
							<span class="font-mono text-xs tabular-nums" title="Flatness">{m.flatness.toFixed(3)} mm</span>
							<span class="w-24 text-right font-mono text-[0.6875rem] text-muted-foreground tabular-nums" title="Largest change from the reference when it arrived">{m.change != null ? `Δ ${m.change.toFixed(3)}` : ''}</span>
							{#if canControl}
								<div class="flex items-center">
									<button class="btn btn-ghost btn-icon min-h-9 min-w-9" title="Use as reference" aria-label="Use the mesh of {when(m.createdAt)} as reference" disabled={m.id === data.referenceId} onclick={() => setReference(m)}><Star /></button>
									<button class="btn btn-ghost btn-icon min-h-9 min-w-9 hover:text-danger" title="Delete" aria-label="Delete the mesh of {when(m.createdAt)}" onclick={() => remove(m)}><Trash2 /></button>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</div>

<style>
	@keyframes -global-mesh-indeterminate {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(300%);
		}
	}
</style>
