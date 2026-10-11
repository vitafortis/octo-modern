<script lang="ts">
	/**
	 * Flatness (max − min) of each stored mesh over time: one line, a dashed line at the
	 * alert limit when set, meshes that broke a limit as amber dots, and a crosshair tooltip.
	 * One series, so no legend; the card title names it.
	 */
	import type { MeshSummary } from '#lib/bedmesh.ts';

	let { meshes, limit = null, height = 120 }: { meshes: MeshSummary[]; limit?: number | null; height?: number } = $props();

	let width = $state(320);
	let hover = $state<number | null>(null);
	const PAD = { top: 10, right: 10, bottom: 18, left: 40 };
	const pts = $derived([...meshes].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((m) => ({ at: Date.parse(m.createdAt), v: m.flatness, m })));
	const innerW = $derived(Math.max(10, width - PAD.left - PAD.right));
	const innerH = $derived(height - PAD.top - PAD.bottom);
	const t0 = $derived(pts[0]?.at ?? 0);
	const t1 = $derived(Math.max(t0 + 1, pts.at(-1)?.at ?? 1));
	const top = $derived(Math.max(0.05, ...(limit != null ? [limit * 1.15] : []), ...pts.map((p) => p.v * 1.15)));
	const x = (at: number) => PAD.left + (pts.length < 2 ? innerW / 2 : ((at - t0) / (t1 - t0)) * innerW);
	const y = (v: number) => PAD.top + (1 - Math.max(0, Math.min(1, v / top))) * innerH;
	const path = $derived(pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(''));
	const hp = $derived(hover != null ? pts[hover] : null);
	const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

	function onmove(e: PointerEvent) {
		if (!pts.length) return;
		const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
		const px = e.clientX - rect.left;
		let best = 0;
		for (let i = 1; i < pts.length; i++) if (Math.abs(x(pts[i].at) - px) < Math.abs(x(pts[best].at) - px)) best = i;
		hover = best;
	}
</script>

<div class="relative" bind:clientWidth={width} data-testid="flatness-trend">
	<svg {width} {height} role="img" aria-label="Bed flatness over time" class="block touch-pan-y select-none" onpointermove={onmove} onpointerleave={() => (hover = null)}>
		{#each [0, top / 2, top] as v (v)}
			<line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--border)" stroke-width="1" />
			<text x={PAD.left - 6} y={y(v) + 3} text-anchor="end" class="fill-muted-foreground font-mono text-[0.625rem]">{v.toFixed(2)}</text>
		{/each}
		{#if limit != null}
			<line x1={PAD.left} x2={width - PAD.right} y1={y(limit)} y2={y(limit)} stroke="var(--warning)" stroke-width="1" stroke-dasharray="4 4" />
			<text x={width - PAD.right - 2} y={y(limit) - 4} text-anchor="end" class="fill-muted-foreground text-[0.625rem]">limit</text>
		{/if}
		{#if pts.length > 1}<path d={path} fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />{/if}
		{#each pts as p, i (p.m.id)}
			{#if p.m.drift || pts.length === 1 || hover === i}
				<circle cx={x(p.at)} cy={y(p.v)} r="4" fill={p.m.drift ? 'var(--warning)' : 'var(--primary)'} stroke="var(--card)" stroke-width="2" />
			{/if}
		{/each}
		{#if hp}
			<line x1={x(hp.at)} x2={x(hp.at)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--muted-foreground)" stroke-opacity="0.5" stroke-width="1" />
		{/if}
		{#if pts.length}
			<text x={PAD.left} y={height - 4} class="fill-muted-foreground text-[0.625rem]">{day(t0)}</text>
			<text x={width - PAD.right} y={height - 4} text-anchor="end" class="fill-muted-foreground text-[0.625rem]">{day(t1)}</text>
		{/if}
	</svg>
	{#if hp}
		<div
			class="pointer-events-none absolute top-0 rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem] shadow-[var(--shadow)]"
			style="left:{Math.min(Math.max(0, x(hp.at) - 70), Math.max(0, width - 150))}px"
		>
			<span class="font-mono tabular-nums">{hp.v.toFixed(3)} mm</span>
			<span class="text-muted-foreground"> · {new Date(hp.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
		</div>
	{/if}
</div>
