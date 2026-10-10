<script lang="ts">
	import { heaterColor, heaterLabel, type TempSample } from '#lib/printer.ts';

	/**
	 * Actual (solid) and target (dashed) temperature per heater over a time window,
	 * with a crosshair tooltip. One y-axis in °C; colors follow the heater, not its rank.
	 */
	let { samples, heaters, windowMs, height = 220 }: { samples: TempSample[]; heaters: string[]; windowMs: number; height?: number } = $props();

	let width = $state(600);
	let hoverX = $state<number | null>(null);

	const PAD = { top: 10, right: 12, bottom: 22, left: 36 };

	const tools = $derived(heaters.filter((k) => k.startsWith('tool')).length);
	const end = $derived(samples.at(-1)?.t ?? Date.now());
	const start = $derived(end - windowMs);
	const visible = $derived(samples.filter((s) => s.t >= start));

	const yMax = $derived.by(() => {
		let m = 0;
		for (const s of visible) for (const k of heaters) for (const v of s.v[k] ?? []) if (v != null && v > m) m = v;
		const top = Math.max(50, m + 10);
		const step = top > 150 ? 50 : 25;
		return Math.ceil(top / step) * step;
	});
	const yTicks = $derived.by(() => {
		const step = yMax > 150 ? 50 : 25;
		const out: number[] = [];
		for (let v = 0; v <= yMax; v += step) out.push(v);
		return out;
	});

	const innerW = $derived(Math.max(10, width - PAD.left - PAD.right));
	const innerH = $derived(height - PAD.top - PAD.bottom);
	const x = (t: number) => PAD.left + ((t - start) / windowMs) * innerW;
	const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;

	/** Path through the points of one series; gaps (null) break the line. */
	function path(key: string, idx: 0 | 1, step = false): string {
		let d = '';
		let pen = false;
		for (const s of visible) {
			const v = s.v[key]?.[idx];
			if (v == null) {
				pen = false;
				continue;
			}
			const px = x(s.t).toFixed(1);
			const py = y(v).toFixed(1);
			if (!pen) d += `M${px},${py}`;
			else d += step ? `H${px}V${py}` : `L${px},${py}`;
			pen = true;
		}
		return d;
	}

	const xTicks = $derived.by(() => {
		const stepMs = windowMs <= 5 * 60_000 ? 60_000 : windowMs <= 15 * 60_000 ? 3 * 60_000 : 5 * 60_000;
		const out: number[] = [];
		for (let t = Math.ceil(start / stepMs) * stepMs; t <= end; t += stepMs) out.push(t);
		return out;
	});
	const timeFmt = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

	const hovered = $derived.by(() => {
		if (hoverX == null || !visible.length) return null;
		const t = start + ((hoverX - PAD.left) / innerW) * windowMs;
		let best = visible[0];
		for (const s of visible) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
		return best;
	});

	function onmove(e: PointerEvent) {
		const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
		const px = e.clientX - rect.left;
		hoverX = px >= PAD.left && px <= width - PAD.right ? px : null;
	}
</script>

<div class="relative" bind:clientWidth={width}>
	<svg {width} {height} role="img" aria-label="Temperature chart" class="block touch-none select-none" onpointermove={onmove} onpointerleave={() => (hoverX = null)}>
		{#each yTicks as v (v)}
			<line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--border)" stroke-width="1" />
			<text x={PAD.left - 6} y={y(v) + 3.5} text-anchor="end" class="fill-muted-foreground font-mono text-[10px]">{v}°</text>
		{/each}
		{#each xTicks as t (t)}
			<text x={x(t)} y={height - 6} text-anchor="middle" class="fill-muted-foreground font-mono text-[10px]">{timeFmt(t)}</text>
		{/each}

		{#each heaters as k (k)}
			<path d={path(k, 1, true)} fill="none" stroke={heaterColor(k)} stroke-width="1.5" stroke-dasharray="4 4" stroke-opacity="0.75" />
			<path d={path(k, 0)} fill="none" stroke={heaterColor(k)} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
		{/each}

		{#if hovered}
			{@const hx = x(hovered.t)}
			<line x1={hx} x2={hx} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--muted-foreground)" stroke-opacity="0.5" stroke-width="1" />
			{#each heaters as k (k)}
				{@const v = hovered.v[k]?.[0]}
				{#if v != null}<circle cx={hx} cy={y(v)} r="4" fill={heaterColor(k)} stroke="var(--card)" stroke-width="2" />{/if}
			{/each}
		{/if}
	</svg>

	{#if hovered}
		{@const hx = x(hovered.t)}
		<div
			class="pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border border-border bg-card px-2.5 py-2 text-[11px] shadow-surface-lg"
			style={hx > width / 2 ? `right:${width - hx + 10}px` : `left:${hx + 10}px`}
		>
			<p class="mb-1 font-mono text-muted-foreground">{new Date(hovered.t).toLocaleTimeString()}</p>
			{#each heaters as k (k)}
				{@const v = hovered.v[k]}
				{#if v}
					<p class="flex items-center gap-2">
						<span class="size-2 rounded-full" style="background:{heaterColor(k)}"></span>
						<span class="flex-1 text-muted-foreground">{heaterLabel(k, tools)}</span>
						<span class="font-mono tabular-nums">{v[0] != null ? `${v[0].toFixed(1)}°` : '—'}<span class="text-muted-foreground"> / {v[1] ? `${v[1]}°` : 'off'}</span></span>
					</p>
				{/if}
			{/each}
		</div>
	{/if}

	{#if !visible.length}
		<p class="absolute inset-0 grid place-items-center text-xs text-muted-foreground">Waiting for temperature data…</p>
	{/if}
</div>
