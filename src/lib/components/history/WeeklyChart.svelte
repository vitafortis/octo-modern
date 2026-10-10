<script lang="ts">
	import { formatDuration } from '#lib/printer.ts';
	import type { WeekStats } from '#lib/history.ts';

	/** Prints per week, stacked by outcome (status colors, with a legend and a hover tooltip). */
	let { weeks: given }: { weeks: WeekStats[] } = $props();

	/** At least eight weeks, so a short history still reads as a timeline. */
	const MIN_WEEKS = 8;
	const weeks = $derived.by(() => {
		if (!given.length || given.length >= MIN_WEEKS) return given;
		const first = new Date(`${given[0].week}T00:00:00Z`).getTime();
		const pad = Array.from({ length: MIN_WEEKS - given.length }, (_, i) => {
			const week = new Date(first - (MIN_WEEKS - given.length - i) * 7 * 86_400_000).toISOString().slice(0, 10);
			return { week, prints: 0, success: 0, failed: 0, cancelled: 0, printTime: 0, filamentMm: 0 };
		});
		return [...pad, ...given];
	});

	const SERIES = [
		{ key: 'success', label: 'Success', color: 'var(--success)' },
		{ key: 'failed', label: 'Failed', color: 'var(--danger)' },
		{ key: 'cancelled', label: 'Cancelled', color: 'var(--warning)' }
	] as const;

	let width = $state(600);
	const height = 168;
	const pad = { top: 8, right: 4, bottom: 22, left: 28 };
	let hover = $state<number | null>(null);

	const max = $derived(Math.max(1, ...weeks.map((w) => w.prints)));
	// Integer ticks: 1, 2, 5, 10… steps, at most four lines.
	const step = $derived([1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => max / s <= 4) ?? 1000);
	const top = $derived(Math.ceil(max / step) * step);
	const ticks = $derived(Array.from({ length: top / step + 1 }, (_, i) => i * step));
	const plotW = $derived(Math.max(10, width - pad.left - pad.right));
	const plotH = height - pad.top - pad.bottom;
	const band = $derived(plotW / Math.max(1, weeks.length));
	const barW = $derived(Math.max(3, Math.min(28, band * 0.62)));
	const y = (v: number) => pad.top + plotH - (v / top) * plotH;
	const x = (i: number) => pad.left + i * band + band / 2;
	const labelEvery = $derived(Math.max(1, Math.ceil(weeks.length / Math.max(1, Math.floor(plotW / 56)))));
	const fmtWeek = (w: string) => new Date(`${w}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

	/** Stacked segments of one week, bottom up, with a 2px gap between them; the top one gets rounded corners. */
	function segments(w: WeekStats) {
		const out: { key: string; color: string; y0: number; y1: number; top: boolean }[] = [];
		let acc = 0;
		const present = SERIES.filter((s) => w[s.key] > 0);
		present.forEach((s, i) => {
			const y0 = y(acc);
			acc += w[s.key];
			const y1 = y(acc);
			out.push({ key: s.key, color: s.color, y0: i === 0 ? y0 : y0 - 1, y1: i === present.length - 1 ? y1 : y1 + 1, top: i === present.length - 1 });
		});
		return out;
	}

	function topRounded(cx: number, w: number, y0: number, y1: number, r = 3) {
		const h = y0 - y1;
		const rr = Math.min(r, h, w / 2);
		const l = cx - w / 2;
		return `M${l},${y0} V${y1 + rr} Q${l},${y1} ${l + rr},${y1} H${l + w - rr} Q${l + w},${y1} ${l + w},${y1 + rr} V${y0} Z`;
	}

	const hovered = $derived(hover != null ? weeks[hover] : null);
</script>

<div class="relative" bind:clientWidth={width}>
	<div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
		{#each SERIES as s (s.key)}
			<span class="flex items-center gap-1.5"><span class="size-2 rounded-sm" style="background:{s.color}"></span>{s.label}</span>
		{/each}
	</div>
	<svg {width} {height} role="img" aria-label="Prints per week by outcome" class="block overflow-visible">
		{#each ticks as t (t)}
			<line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--border)" stroke-dasharray={t === 0 ? undefined : '2 3'} />
			<text x={pad.left - 6} y={y(t) + 3.5} text-anchor="end" class="fill-muted-foreground font-mono text-[10px]">{t}</text>
		{/each}
		{#each weeks as w, i (w.week)}
			{#each segments(w) as seg (seg.key)}
				{#if seg.top}
					<path d={topRounded(x(i), barW, seg.y0, seg.y1)} fill={seg.color} opacity={hover == null || hover === i ? 1 : 0.45} />
				{:else}
					<rect x={x(i) - barW / 2} y={seg.y1} width={barW} height={Math.max(0, seg.y0 - seg.y1)} fill={seg.color} opacity={hover == null || hover === i ? 1 : 0.45} />
				{/if}
			{/each}
			{#if i % labelEvery === 0}
				<text x={x(i)} y={height - 6} text-anchor="middle" class="fill-muted-foreground text-[10px]">{fmtWeek(w.week)}</text>
			{/if}
			<!-- Hit target: the whole column, not just the bar. -->
			<rect
				x={x(i) - band / 2}
				y={pad.top}
				width={band}
				height={plotH}
				fill="transparent"
				role="presentation"
				onpointerenter={() => (hover = i)}
				onpointerleave={() => (hover = null)}
			/>
		{/each}
	</svg>
	{#if hovered && hover != null}
		<div
			class="pointer-events-none absolute z-10 min-w-36 rounded-lg border border-border bg-card px-3 py-2 text-[11px] shadow-surface-lg"
			style="left:{Math.min(Math.max(x(hover) - 72, 0), width - 150)}px; top:{Math.max(0, y(hovered.prints) - 8)}px; transform: translateY(-100%)"
		>
			<p class="mb-1 font-medium text-foreground">Week of {fmtWeek(hovered.week)}</p>
			{#each SERIES as s (s.key)}
				<p class="flex items-center gap-1.5 text-muted-foreground">
					<span class="size-2 rounded-sm" style="background:{s.color}"></span>{s.label}<span class="ml-auto pl-3 font-mono text-foreground tabular-nums">{hovered[s.key]}</span>
				</p>
			{/each}
			<p class="mt-1 border-t border-border pt-1 text-muted-foreground">Print time <span class="float-right pl-3 font-mono text-foreground">{formatDuration(hovered.printTime)}</span></p>
		</div>
	{/if}
</div>
