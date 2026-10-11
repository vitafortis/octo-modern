<script lang="ts" module>
	/**
	 * Stacked columns over time, hand-rolled SVG: a legend above, recessive grid, 2px gaps
	 * between segments, a tooltip on hover/tap, and the same numbers as a table for screen readers.
	 */
	export interface Column {
		key: string;
		/** Axis label. */
		label: string;
		/** Tooltip and table label. */
		title: string;
		/** One value per series. */
		values: number[];
	}
	export interface Series {
		label: string;
		color: string;
	}
</script>

<script lang="ts">
	let {
		columns,
		series,
		format,
		axisFormat = format,
		label,
		height = 184,
		footer
	}: {
		columns: Column[];
		series: Series[];
		format: (v: number) => string;
		axisFormat?: (v: number) => string;
		/** Names the chart for assistive tech. */
		label: string;
		height?: number;
		/** Extra line in the tooltip, e.g. a total. */
		footer?: (c: Column) => string;
	} = $props();

	let width = $state(600);
	let hover = $state<number | null>(null);
	const pad = { top: 8, right: 4, bottom: 22, left: 36 };

	const total = (c: Column) => c.values.reduce((s, v) => s + v, 0);
	const max = $derived(Math.max(0, ...columns.map(total)));
	/** 1/2/2.5/5 × 10ⁿ steps, at most four grid lines. */
	const step = $derived.by(() => {
		if (max <= 0) return 1;
		const raw = max / 4;
		const p = 10 ** Math.floor(Math.log10(raw));
		return ([1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p);
	});
	const top = $derived(Math.max(step, Math.ceil(max / step) * step));
	const ticks = $derived(Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step));
	const plotW = $derived(Math.max(10, width - pad.left - pad.right));
	const plotH = $derived(height - pad.top - pad.bottom);
	const band = $derived(plotW / Math.max(1, columns.length));
	const barW = $derived(Math.max(2, Math.min(28, band * 0.64)));
	const y = (v: number) => pad.top + plotH - (v / top) * plotH;
	const x = (i: number) => pad.left + i * band + band / 2;
	const labelEvery = $derived(Math.max(1, Math.ceil(columns.length / Math.max(1, Math.floor(plotW / 52)))));

	/** Segments bottom up, 2px apart; the top one gets rounded corners. */
	function segments(c: Column) {
		const out: { i: number; y0: number; y1: number; top: boolean }[] = [];
		const present = series.map((_, i) => i).filter((i) => c.values[i] > 0);
		let acc = 0;
		present.forEach((si, n) => {
			const y0 = y(acc);
			acc += c.values[si];
			const y1 = y(acc);
			out.push({ i: si, y0: n === 0 ? y0 : y0 - 1, y1: n === present.length - 1 ? y1 : y1 + 1, top: n === present.length - 1 });
		});
		return out.filter((s) => s.y0 - s.y1 > 0.5);
	}

	function topRounded(cx: number, w: number, y0: number, y1: number, r = 3) {
		const rr = Math.min(r, y0 - y1, w / 2);
		const l = cx - w / 2;
		return `M${l},${y0} V${y1 + rr} Q${l},${y1} ${l + rr},${y1} H${l + w - rr} Q${l + w},${y1} ${l + w},${y1 + rr} V${y0} Z`;
	}

	const hovered = $derived(hover != null ? columns[hover] : null);
</script>

<div class="relative w-full min-w-0" bind:clientWidth={width}>
	{#if series.length > 1}
		<ul class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem] text-muted-foreground" aria-hidden="true">
			{#each series as s (s.label)}
				<li class="flex items-center gap-1.5"><span class="size-2 shrink-0 rounded-sm" style="background:{s.color}"></span>{s.label}</li>
			{/each}
		</ul>
	{/if}
	<svg {width} {height} class="block overflow-visible" aria-hidden="true">
		{#each ticks as t (t)}
			<line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--border)" stroke-dasharray={t === 0 ? undefined : '2 3'} />
			<text x={pad.left - 6} y={y(t) + 3.5} text-anchor="end" class="fill-muted-foreground font-mono text-[0.625rem]">{axisFormat(t)}</text>
		{/each}
		{#each columns as c, i (c.key)}
			{#each segments(c) as seg (seg.i)}
				{#if seg.top}
					<path d={topRounded(x(i), barW, seg.y0, seg.y1)} fill={series[seg.i].color} opacity={hover == null || hover === i ? 1 : 0.45} />
				{:else}
					<rect x={x(i) - barW / 2} y={seg.y1} width={barW} height={seg.y0 - seg.y1} fill={series[seg.i].color} opacity={hover == null || hover === i ? 1 : 0.45} />
				{/if}
			{/each}
			{#if i % labelEvery === 0}
				<text x={x(i)} y={height - 6} text-anchor="middle" class="fill-muted-foreground text-[0.625rem]">{c.label}</text>
			{/if}
			<!-- Hit target: the whole column. -->
			<rect
				x={x(i) - band / 2}
				y={pad.top}
				width={band}
				height={plotH}
				fill="transparent"
				role="presentation"
				onpointerenter={() => (hover = i)}
				onpointerleave={() => (hover = null)}
				onpointerdown={() => (hover = i)}
			/>
		{/each}
	</svg>
	{#if hovered && hover != null}
		<div
			class="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-border bg-card px-3 py-2 text-[0.6875rem] shadow-surface-lg"
			style="left:{Math.min(Math.max(x(hover) - 80, 0), Math.max(0, width - 176))}px; top:{Math.max(0, y(total(hovered)) - 8) + (series.length > 1 ? 24 : 0)}px; transform: translateY(-100%)"
		>
			<p class="mb-1 font-medium text-foreground">{hovered.title}</p>
			{#each series as s, si (s.label)}
				{#if hovered.values[si] > 0 || series.length <= 4}
					<p class="flex items-center gap-1.5 text-muted-foreground">
						<span class="size-2 shrink-0 rounded-sm" style="background:{s.color}"></span>{s.label}<span class="ml-auto pl-3 font-mono text-foreground tabular-nums">{format(hovered.values[si])}</span>
					</p>
				{/if}
			{/each}
			{#if footer}<p class="mt-1 border-t border-border pt-1 text-muted-foreground">{footer(hovered)}</p>{/if}
		</div>
	{/if}
	<!-- In a wrapper: a table ignores sr-only’s 1px width and would widen the page. -->
	<div class="sr-only"><table>
		<caption>{label}</caption>
		<thead><tr><th scope="col">Period</th>{#each series as s (s.label)}<th scope="col">{s.label}</th>{/each}</tr></thead>
		<tbody>
			{#each columns as c (c.key)}
				<tr><th scope="row">{c.title}</th>{#each c.values as v, i (i)}<td>{format(v)}</td>{/each}</tr>
			{/each}
		</tbody>
	</table></div>
</div>
