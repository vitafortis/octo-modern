<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Box, ChevronDown, ChevronUp, CircleAlert, Crosshair, Eye, EyeOff, Layers, LoaderCircle, Maximize2, Minimize2, Navigation, RotateCcw, Route } from '@lucide/svelte';
	import { loadToolpath, type Loaded } from '#lib/gcode/load.ts';
	import { EXTRUSION, FEATURES, TRAVEL, locate, type Toolpath } from '#lib/gcode/parse.ts';
	import { ToolpathRenderer, cssColor, type ViewMode } from '#lib/gcode/render.ts';
	import { bytes, compact, duration } from '#lib/client/format.ts';
	import { theme } from '#lib/client/state.svelte.ts';

	/**
	 * A G-code toolpath preview: parsed in a Web Worker, drawn with WebGL2. 3D orbit view
	 * or 2D layer view, a layer slider, travel moves on/off, colours by feature type
	 * (click a legend entry to hide it). With `filepos` (OctoPrint's progress.filepos for
	 * this file) it marks what's printed, where the nozzle is, and follows the print.
	 */
	let {
		url,
		cacheKey,
		filepos = null,
		live = false,
		class: cls = ''
	}: {
		url: string;
		/** Cache key for the parsed file (path + size + date). */
		cacheKey: string;
		/** Bytes of the file OctoPrint has read (live job). */
		filepos?: number | null;
		/** This is the job being printed (enables follow and the nozzle marker). */
		live?: boolean;
		class?: string;
	} = $props();

	let canvas = $state<HTMLCanvasElement>();
	let wrap = $state<HTMLElement>();
	let renderer: ToolpathRenderer | null = null;
	let loaded = $state.raw<Loaded | null>(null);
	let error = $state('');
	let progress = $state<{ bytes: number; total: number | null } | null>(null);
	let mode = $state<ViewMode>('3d');
	let layer = $state(0);
	let showTravel = $state(false);
	let hidden = $state(0);
	let follow = $state(true);
	let ghost = $state(true);
	let full = $state(false);
	let marker = $state<{ x: number; y: number } | null>(null);

	const tp = $derived<Toolpath | null>(loaded?.toolpath ?? null);
	const layers = $derived(tp ? tp.layerStart.length - 1 : 0);
	const here = $derived(tp && live && filepos != null ? locate(tp, filepos) : null);
	const kindsShown = $derived(tp ? FEATURES.map((f, i) => ({ ...f, i })).filter((f) => tp.stats.kindsSeen & (1 << f.i)) : []);
	const z = $derived(tp && layers ? tp.layerZ[Math.min(layer, layers - 1)] : null);

	function readColors() {
		if (!renderer || !wrap) return;
		const st = getComputedStyle(wrap);
		const kinds = Array.from({ length: 16 }, (_, i) => {
			const id = i === TRAVEL ? 'travel' : FEATURES[i]?.id ?? 'custom';
			return cssColor(st.getPropertyValue(`--gc-${id}`).trim());
		});
		renderer.setColors(kinds, cssColor(st.getPropertyValue('--gc-grid').trim()));
	}

	onMount(() => {
		try {
			renderer = new ToolpathRenderer(canvas!);
		} catch (err) {
			error = (err as Error).message;
			return;
		}
		renderer.onframe = placeMarker;
		readColors();
		const ro = new ResizeObserver(() => renderer?.redraw());
		ro.observe(canvas!);
		return () => {
			ro.disconnect();
			renderer?.dispose();
			renderer = null;
		};
	});

	// Theme switch: colours come from CSS tokens.
	$effect(() => {
		void theme.value;
		queueMicrotask(readColors);
	});

	// Load (again) when the file changes.
	$effect(() => {
		const u = url;
		const key = cacheKey;
		const abort = new AbortController();
		untrack(() => {
			error = '';
			loaded = null;
			progress = { bytes: 0, total: null };
		});
		loadToolpath(u, key, { signal: abort.signal, onprogress: (b, t) => (progress = { bytes: b, total: t }) })
			.then((r) => {
				progress = null;
				if (!r.toolpath.stats.points) {
					error = 'No moves found in this file.';
					return;
				}
				loaded = r;
				const n = r.toolpath.layerStart.length - 1;
				const at = live && filepos != null ? locate(r.toolpath, filepos) : null;
				layer = at ? at.layer : n - 1;
				renderer?.upload(r.toolpath);
			})
			.catch((err) => {
				if ((err as Error).name === 'AbortError') return;
				progress = null;
				error = (err as Error).message;
			});
		return () => abort.abort();
	});

	// Follow the print.
	$effect(() => {
		if (here && follow) layer = here.layer;
	});

	// Push view state to the renderer.
	$effect(() => {
		if (!renderer || !tp) return;
		const s = renderer.state;
		const modeChanged = s.mode !== mode;
		s.mode = mode;
		s.layer = layer;
		s.showTravel = showTravel;
		s.hidden = hidden;
		s.current = here ? here.point : -1;
		s.ghost = ghost;
		if (modeChanged) renderer.resetView();
		renderer.redraw();
	});

	function placeMarker() {
		if (!renderer || !tp || !here) {
			marker = null;
			return;
		}
		const i = here.point * 3;
		const p = renderer.project(tp.positions[i], tp.positions[i + 1], tp.positions[i + 2]);
		marker = p && (mode === '3d' ? layer >= here.layer : layer === here.layer) ? { x: p[0], y: p[1] } : null;
	}

	function step(d: number) {
		follow = false;
		layer = Math.max(0, Math.min(layers - 1, layer + d));
	}

	function toggleKind(i: number) {
		hidden ^= 1 << i;
	}

	// --- pointer: orbit/pan/pinch -----------------------------------------------------------
	const pointers = new Map<number, { x: number; y: number; button: number; shift: boolean }>();
	let pinch: { d: number; mx: number; my: number } | null = null;
	let lastTap = 0;

	function pinchState() {
		const [a, b] = [...pointers.values()];
		return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
	}

	function onpointerdown(e: PointerEvent) {
		canvas!.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey || e.ctrlKey || e.metaKey });
		if (pointers.size === 2) pinch = pinchState();
		if (e.pointerType === 'touch' && pointers.size === 1) {
			const now = Date.now();
			if (now - lastTap < 300) renderer?.resetView();
			lastTap = now;
		}
	}

	function onpointermove(e: PointerEvent) {
		const p = pointers.get(e.pointerId);
		if (!p || !renderer) return;
		const dx = e.clientX - p.x;
		const dy = e.clientY - p.y;
		p.x = e.clientX;
		p.y = e.clientY;
		if (pointers.size === 2 && pinch) {
			const next = pinchState();
			const rect = canvas!.getBoundingClientRect();
			if (pinch.d > 0 && next.d > 0) renderer.zoom(next.d / pinch.d, [next.mx - rect.left, next.my - rect.top]);
			renderer.pan(next.mx - pinch.mx, next.my - pinch.my);
			pinch = next;
			return;
		}
		if (pointers.size !== 1) return;
		if (mode === '2d' || p.button === 2 || p.button === 1 || p.shift) renderer.pan(dx, dy);
		else renderer.orbit(dx, dy);
	}

	function onpointerup(e: PointerEvent) {
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
	}

	function onwheel(e: WheelEvent) {
		e.preventDefault();
		const rect = canvas!.getBoundingClientRect();
		renderer?.zoom(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), [e.clientX - rect.left, e.clientY - rect.top]);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowUp' || e.key === 'PageUp') step(e.key === 'PageUp' ? 10 : 1);
		else if (e.key === 'ArrowDown' || e.key === 'PageDown') step(e.key === 'PageDown' ? -10 : -1);
		else if (e.key === 'Home') step(-layers);
		else if (e.key === 'End') step(layers);
		else return;
		e.preventDefault();
	}

	async function toggleFull() {
		if (document.fullscreenElement) {
			await document.exitFullscreen();
			return;
		}
		if (!full && wrap?.requestFullscreen) {
			try {
				await wrap.requestFullscreen();
				return;
			} catch {}
		}
		// No element fullscreen (iPhone Safari): fill the window instead.
		full = !full;
		renderer?.redraw();
	}

	$effect(() => {
		const onchange = () => {
			full = !!document.fullscreenElement && document.fullscreenElement === wrap;
			renderer?.redraw();
		};
		document.addEventListener('fullscreenchange', onchange);
		return () => document.removeEventListener('fullscreenchange', onchange);
	});

	const pct = $derived(progress?.total ? Math.min(100, (progress.bytes / progress.total) * 100) : null);
</script>

<div
	bind:this={wrap}
	class="flex min-h-0 flex-col overflow-hidden border border-border bg-card {full ? 'fixed inset-0 z-50 rounded-none' : 'rounded-xl'} {cls}"
	data-testid="gcode-viewer"
>
	<!-- Toolbar -->
	<div class="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
		<div class="flex rounded-lg border border-border bg-surface p-0.5" role="radiogroup" aria-label="View">
			{#each [['3d', '3D', Box], ['2d', 'Layer', Layers]] as const as [m, label, Icon] (m)}
				<button
					role="radio"
					aria-checked={mode === m}
					class="flex h-8 min-w-11 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors {mode === m ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
					onclick={() => (mode = m)}><Icon class="size-3.5" />{label}</button
				>
			{/each}
		</div>
		<button class="btn btn-ghost btn-sm h-9 {showTravel ? 'text-primary' : ''}" aria-pressed={showTravel} title="Show travel moves" onclick={() => (showTravel = !showTravel)}><Route />Travel</button>
		{#if live}
			<button class="btn btn-ghost btn-sm h-9 {ghost ? 'text-primary' : ''}" aria-pressed={ghost} title="Show what's still to print as a ghost" onclick={() => (ghost = !ghost)}>
				{#if ghost}<Eye />{:else}<EyeOff />{/if}<span class="hidden sm:inline">Remaining</span>
			</button>
		{/if}
		<div class="ml-auto flex items-center gap-1">
			{#if tp}
				<span class="mr-1 hidden font-mono text-[11px] text-muted-foreground tabular-nums md:inline" title="Parsed {compact(tp.stats.moves)} moves into {compact(tp.stats.points)} points">
					{compact(tp.stats.moves)} moves · {bytes(tp.stats.bytes)} · {duration(loaded!.ms)}
				</span>
			{/if}
			<button class="btn btn-ghost btn-icon btn-sm size-9" title="Reset view (double-tap)" aria-label="Reset view" onclick={() => renderer?.resetView()}><RotateCcw /></button>
			<button class="btn btn-ghost btn-icon btn-sm size-9" title={full ? 'Exit full screen' : 'Full screen'} aria-label={full ? 'Exit full screen' : 'Full screen'} onclick={toggleFull}>
				{#if full}<Minimize2 />{:else}<Maximize2 />{/if}
			</button>
		</div>
	</div>

	<!-- Canvas -->
	<div class="relative min-h-0 flex-1 {full ? '' : 'h-[min(62vh,40rem)] min-h-72'}" style="background: radial-gradient(120% 90% at 50% 0%, var(--surface), var(--card));">
		<canvas
			bind:this={canvas}
			class="absolute inset-0 size-full touch-none outline-none select-none"
			tabindex="0"
			aria-label="Toolpath preview. Drag to rotate, scroll or pinch to zoom, arrow keys change the layer."
			{onpointerdown}
			{onpointermove}
			{onpointerup}
			onpointercancel={onpointerup}
			{onwheel}
			{onkeydown}
			oncontextmenu={(e) => e.preventDefault()}
			ondblclick={() => renderer?.resetView()}
		></canvas>

		{#if marker}
			<span class="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white" style="left:{marker.x}px; top:{marker.y}px; background: var(--gc-nozzle); box-shadow: 0 0 0 4px color-mix(in oklab, var(--gc-nozzle) 35%, transparent);" data-testid="gcode-nozzle"></span>
		{/if}

		{#if tp}
			<div class="pointer-events-none absolute top-2 left-2 flex flex-col items-start gap-1">
				<span class="rounded-md border border-border bg-card/85 px-2 py-1 font-mono text-[11px] tabular-nums shadow-surface backdrop-blur" data-testid="gcode-layer">
					Layer {layer + 1} / {layers}{#if z != null}{' · '}Z {z.toFixed(2)}{/if}
				</span>
				{#if here}
					<span class="flex items-center gap-1 rounded-md border border-primary/30 bg-primary-soft/90 px-2 py-1 text-[11px] font-medium text-primary backdrop-blur" data-testid="gcode-printing">
						<Crosshair class="size-3" />Printing layer {here.layer + 1}
					</span>
				{/if}
				{#if tp.stats.minSegment > 0}
					<span class="rounded-md border border-border bg-card/85 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur" title="Very large file: segments shorter than {tp.stats.minSegment} mm were merged to fit in memory">Simplified ({tp.stats.minSegment} mm)</span>
				{/if}
			</div>
		{/if}

		{#if progress}
			<div class="absolute inset-0 grid place-items-center">
				<div class="w-64 max-w-[80%] rounded-xl border border-border bg-card/90 p-4 text-center shadow-surface backdrop-blur">
					<LoaderCircle class="mx-auto size-5 animate-spin text-primary" />
					<p class="mt-2 text-[13px] font-medium">Reading G-code…</p>
					<p class="mt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">{bytes(progress.bytes)}{progress.total ? ` of ${bytes(progress.total)}` : ''}</p>
					<div class="mt-2 h-1 overflow-hidden rounded-full bg-border"><div class="h-full rounded-full bg-primary transition-[width]" style="width:{pct ?? 30}%"></div></div>
				</div>
			</div>
		{:else if error}
			<div class="absolute inset-0 grid place-items-center p-6">
				<div class="max-w-sm text-center">
					<CircleAlert class="mx-auto size-6 text-danger" />
					<p class="mt-2 text-[13px] font-medium">Can’t show this file</p>
					<p class="mt-1 text-xs text-muted-foreground">{error}</p>
				</div>
			</div>
		{/if}
	</div>

	<!-- Layer slider -->
	{#if tp && layers > 0}
		<div class="flex items-center gap-2 border-t border-border px-2 py-1.5">
			<button class="btn btn-ghost btn-icon size-11 shrink-0 sm:size-9" aria-label="Layer down" onclick={() => step(-1)} disabled={layer <= 0}><ChevronDown /></button>
			<input
				class="range [&::-moz-range-thumb]:size-5 [&::-webkit-slider-thumb]:size-5"
				style="--fill:{layers > 1 ? (layer / (layers - 1)) * 100 : 100}%"
				type="range"
				min="0"
				max={layers - 1}
				step="1"
				aria-label="Layer"
				data-testid="gcode-slider"
				value={layer}
				oninput={(e) => {
					follow = false;
					layer = Number((e.currentTarget as HTMLInputElement).value);
				}}
			/>
			<button class="btn btn-ghost btn-icon size-11 shrink-0 sm:size-9" aria-label="Layer up" onclick={() => step(1)} disabled={layer >= layers - 1}><ChevronUp /></button>
			{#if here}
				<button class="btn btn-sm h-9 shrink-0 {follow ? 'btn-secondary text-primary' : 'btn-ghost'}" aria-pressed={follow} title="Follow the print" onclick={() => (follow = !follow)}><Navigation />Follow</button>
			{/if}
		</div>
	{/if}

	<!-- Legend -->
	{#if tp && kindsShown.length}
		<div class="flex flex-wrap gap-1 border-t border-border px-2 py-1.5" aria-label="Feature types">
			{#each kindsShown as k (k.id)}
				{@const off = (hidden & (1 << k.i)) !== 0}
				<button
					class="flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors hover:bg-accent {off ? 'text-muted-foreground/60 line-through' : 'text-foreground'}"
					aria-pressed={!off}
					title={off ? `Show ${k.label}` : `Hide ${k.label}`}
					onclick={() => toggleKind(k.i)}
				>
					<span class="size-2.5 rounded-sm {off ? 'opacity-30' : ''}" style="background: var(--gc-{k.id})"></span>{k.i === EXTRUSION ? 'Extrusion' : k.label}
				</button>
			{/each}
			{#if showTravel}
				<span class="flex h-8 items-center gap-1.5 px-2 text-[11px] text-muted-foreground"><span class="h-0.5 w-3 rounded-full" style="background: var(--gc-travel)"></span>Travel</span>
			{/if}
		</div>
	{/if}
</div>
