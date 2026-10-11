<script lang="ts">
	/**
	 * A bed mesh as a grid of coloured cells with their values, laid out as seen from the
	 * front of the printer: the back of the bed (highest Y) at the top. The colour scale is
	 * diverging around `center` (the mean for heights, 0 for a difference map); the lowest
	 * and highest points are outlined.
	 */
	import { fmtZ, meshStats, type Mesh } from '#lib/bedmesh.ts';
	import { meshPalette, trackTheme } from '#lib/client/bedmesh.svelte.ts';

	let {
		mesh,
		center,
		range,
		label,
		unit = 'mm',
		testid = 'mesh-heatmap'
	}: { mesh: Mesh; center: number; range: number; label: string; unit?: string; testid?: string } = $props();

	$effect(trackTheme);

	const stats = $derived(meshStats(mesh));
	const cols = $derived(mesh.z[0]?.length ?? 0);
	// Back row first.
	const order = $derived(mesh.z.map((_, i) => i).reverse());
	/** Values in cells only when they fit; always in the tooltip. */
	const dense = $derived(cols > 9);
	const coord = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
	const isMin = (r: number, c: number) => stats?.minAt.row === r && stats?.minAt.col === c;
	const isMax = (r: number, c: number) => stats?.maxAt.row === r && stats?.maxAt.col === c;
</script>

<div class="w-full" data-testid={testid}>
	<div
		class="grid gap-[2px] font-mono"
		style="grid-template-columns: auto repeat({cols}, minmax(0, 1fr));"
		role="table"
		aria-label={label}
	>
		{#each order as r (r)}
			<div class="flex items-center justify-end pr-1.5 text-[0.625rem] text-muted-foreground" role="rowheader">{coord(mesh.ys[r] ?? r)}</div>
			{#each mesh.z[r] as z, c (c)}
				{@const bg = z === null ? 'var(--muted)' : meshPalette.color(z, center, range)}
				<div
					class="relative flex aspect-square min-w-0 items-center justify-center overflow-hidden rounded-[3px] {dense ? 'text-[0.5625rem]' : 'text-[0.625rem] sm:text-[0.6875rem]'} {isMin(r, c) || isMax(r, c) ? 'ring-2 ring-foreground ring-inset' : ''}"
					style="background:{bg}; color:{z === null ? 'var(--muted-foreground)' : meshPalette.ink(bg)}"
					role="cell"
					title="X {coord(mesh.xs[c] ?? c)} · Y {coord(mesh.ys[r] ?? r)}: {z === null ? 'not probed' : `${fmtZ(z)} ${unit}`}{isMin(r, c) ? ' (lowest)' : isMax(r, c) ? ' (highest)' : ''}"
					data-min={isMin(r, c) || undefined}
					data-max={isMax(r, c) || undefined}
				>
					<span class="truncate tabular-nums {dense ? 'max-sm:hidden' : ''}">{z === null ? '·' : fmtZ(z, dense ? 2 : 3, true).replace(/^\+/, '')}</span>
				</div>
			{/each}
		{/each}
		<div></div>
		{#each mesh.xs as x, c (c)}
			<div class="truncate pt-1 text-center text-[0.625rem] text-muted-foreground">{coord(x)}</div>
		{/each}
	</div>
	<!-- Scale -->
	<div class="mt-3 flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
		<span class="font-mono tabular-nums">{fmtZ(center - range)}</span>
		<div class="h-2 flex-1 rounded-full" style="background:linear-gradient(to right, {[0, 0.25, 0.5, 0.75, 1].map((t) => meshPalette.color(center - range + 2 * range * t, center, range)).join(', ')})"></div>
		<span class="font-mono tabular-nums">{fmtZ(center + range)}</span>
		<span>{unit}</span>
	</div>
</div>
