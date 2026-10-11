<script lang="ts">
	/**
	 * The failure score over this print: one line (0–100 %), dashed lines at the warning
	 * (⅓) and failure (⅔) levels, and a crosshair tooltip. One series, so no legend; the
	 * card title names it.
	 */
	import type { DetectPoint } from '#lib/detect.ts';

	let { points, height = 120 }: { points: DetectPoint[]; height?: number } = $props();

	let width = $state(320);
	let hover = $state<number | null>(null);
	const PAD = { top: 8, right: 8, bottom: 18, left: 32 };
	const innerW = $derived(Math.max(10, width - PAD.left - PAD.right));
	const innerH = $derived(height - PAD.top - PAD.bottom);
	const t0 = $derived(points[0]?.at ?? 0);
	const t1 = $derived(Math.max(t0 + 1, points.at(-1)?.at ?? 1));
	const x = (at: number) => PAD.left + (points.length < 2 ? innerW : ((at - t0) / (t1 - t0)) * innerW);
	const y = (v: number) => PAD.top + (1 - Math.max(0, Math.min(1, v))) * innerH;
	const path = $derived(points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.score).toFixed(1)}`).join(''));
	const area = $derived(points.length > 1 ? `${path}L${x(points.at(-1)!.at).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z` : '');
	const hp = $derived(hover != null ? points[hover] : null);
	const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	const levelOf = (v: number) => (v >= 2 / 3 ? 'failure' : v >= 1 / 3 ? 'warning' : 'normal');

	function onmove(e: PointerEvent) {
		if (!points.length) return;
		const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
		const px = e.clientX - rect.left;
		let best = 0;
		for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i].at) - px) < Math.abs(x(points[best].at) - px)) best = i;
		hover = best;
	}
</script>

<div class="relative" bind:clientWidth={width}>
	<svg {width} {height} role="img" aria-label="Failure score over this print" class="block touch-none select-none" onpointermove={onmove} onpointerleave={() => (hover = null)}>
		{#each [0, 0.5, 1] as v (v)}
			<line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--border)" stroke-width="1" />
			<text x={PAD.left - 6} y={y(v) + 3} text-anchor="end" class="fill-muted-foreground font-mono text-[10px]">{Math.round(v * 100)}</text>
		{/each}
		<line x1={PAD.left} x2={width - PAD.right} y1={y(1 / 3)} y2={y(1 / 3)} stroke="var(--warning)" stroke-width="1" stroke-dasharray="4 4" />
		<line x1={PAD.left} x2={width - PAD.right} y1={y(2 / 3)} y2={y(2 / 3)} stroke="var(--danger)" stroke-width="1" stroke-dasharray="4 4" />
		<text x={PAD.left + 4} y={y(1 / 3) - 4} class="fill-muted-foreground text-[10px]">warning</text>
		<text x={PAD.left + 4} y={y(2 / 3) - 4} class="fill-muted-foreground text-[10px]">failure</text>
		{#if area}<path d={area} fill="var(--primary-soft)" />{/if}
		{#if points.length > 1}
			<path d={path} fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
		{:else if points.length === 1}
			<circle cx={x(points[0].at)} cy={y(points[0].score)} r="4" fill="var(--primary)" stroke="var(--card)" stroke-width="2" />
		{/if}
		{#if hp}
			<line x1={x(hp.at)} x2={x(hp.at)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--muted-foreground)" stroke-opacity="0.5" stroke-width="1" />
			<circle cx={x(hp.at)} cy={y(hp.score)} r="4" fill="var(--primary)" stroke="var(--card)" stroke-width="2" />
		{/if}
		{#if points.length}
			<text x={PAD.left} y={height - 4} class="fill-muted-foreground text-[10px]">{time(t0)}</text>
			<text x={width - PAD.right} y={height - 4} text-anchor="end" class="fill-muted-foreground text-[10px]">{time(t1)}</text>
		{/if}
	</svg>
	{#if hp}
		<div
			class="pointer-events-none absolute top-1 rounded-lg border border-border bg-card px-2 py-1 text-[11px] shadow"
			style="left: {Math.min(Math.max(0, x(hp.at) - 60), width - 130)}px"
		>
			<span class="text-muted-foreground">{time(hp.at)}</span>
			<span class="ml-1.5 font-mono font-medium">{Math.round(hp.score * 100)}%</span>
			<span class="ml-1 text-muted-foreground">{levelOf(hp.score)}</span>
		</div>
	{/if}
</div>
