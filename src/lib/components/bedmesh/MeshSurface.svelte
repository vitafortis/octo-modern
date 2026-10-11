<script lang="ts">
	/**
	 * The mesh as a 3D surface on a 2D canvas: each cell is a quad, projected with a light
	 * perspective and drawn back to front (painter's algorithm). A bed mesh is at most a few
	 * hundred quads, so this needs no WebGL or chart library (plotly would add ~1 MB gzipped;
	 * this is a few kB). Drag to rotate, wheel or pinch to zoom, arrow keys and +/− too;
	 * double-click resets. Heights are exaggerated (labelled) so a 0.1 mm bow is visible.
	 */
	import { RotateCcw } from '@lucide/svelte';
	import { fmtZ, type Mesh } from '#lib/bedmesh.ts';
	import { meshPalette, trackTheme } from '#lib/client/bedmesh.svelte.ts';

	let { mesh, center, range, label }: { mesh: Mesh; center: number; range: number; label: string } = $props();

	$effect(trackTheme);

	const DEFAULT = { yaw: -0.6, elev: 0.6, zoom: 1 };
	let yaw = $state(DEFAULT.yaw);
	let elev = $state(DEFAULT.elev);
	let zoom = $state(DEFAULT.zoom);
	let width = $state(480);
	const height = $derived(Math.round(Math.min(420, Math.max(260, width * 0.66))));
	let canvas = $state<HTMLCanvasElement>();

	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
	function reset() {
		yaw = DEFAULT.yaw;
		elev = DEFAULT.elev;
		zoom = DEFAULT.zoom;
	}

	/** Bed coordinates → model space: the longer side spans −1…1, Z scaled by the value range. */
	const model = $derived.by(() => {
		const xs = mesh.xs;
		const ys = mesh.ys;
		const x0 = Math.min(...xs);
		const x1 = Math.max(...xs);
		const y0 = Math.min(...ys);
		const y1 = Math.max(...ys);
		const span = Math.max(x1 - x0, y1 - y0) || 1;
		const nx = (x: number) => (x1 === x0 ? 0 : ((x - (x0 + x1) / 2) / span) * 2);
		const ny = (y: number) => (y1 === y0 ? 0 : ((y - (y0 + y1) / 2) / span) * 2);
		const zr = Math.max(range, 0.005);
		const pts = mesh.z.map((row, r) => row.map((z, c) => (z === null ? null : { x: nx(xs[c] ?? c), y: ny(ys[r] ?? r), z: ((z - center) / zr) * 0.32, v: z })));
		return { pts, hx: x1 === x0 ? 0.05 : ((x1 - x0) / span), hy: y1 === y0 ? 0.05 : ((y1 - y0) / span) };
	});

	function draw() {
		const cv = canvas;
		if (!cv) return;
		const dpr = window.devicePixelRatio || 1;
		cv.width = Math.round(width * dpr);
		cv.height = Math.round(height * dpr);
		const ctx = cv.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		const css = getComputedStyle(cv);
		const border = css.getPropertyValue('--border').trim() || 'gray';
		const muted = css.getPropertyValue('--muted-foreground').trim() || 'gray';
		const card = css.getPropertyValue('--card').trim() || 'white';

		const cy = Math.cos(yaw);
		const sy = Math.sin(yaw);
		const ce = Math.cos(elev);
		const se = Math.sin(elev);
		const scale = Math.min(width, height * 1.4) * 0.31 * zoom;
		const ox = width / 2;
		const oy = height * 0.48;
		const project = (x: number, y: number, z: number) => {
			const x1 = x * cy - y * sy;
			const y1 = x * sy + y * cy;
			const up = y1 * se + z * ce;
			const depth = -y1 * ce + z * se;
			const k = 4 / (4 - depth);
			return { sx: ox + x1 * scale * k, sy: oy - up * scale * k, depth };
		};

		// The bed plate under the surface.
		const base = -0.42;
		const { hx, hy } = model;
		const plate = [
			[-hx, -hy],
			[hx, -hy],
			[hx, hy],
			[-hx, hy]
		].map(([x, y]) => project(x, y, base));
		ctx.beginPath();
		plate.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
		ctx.closePath();
		ctx.fillStyle = border;
		ctx.globalAlpha = 0.35;
		ctx.fill();
		ctx.globalAlpha = 1;
		ctx.strokeStyle = border;
		ctx.lineWidth = 1;
		ctx.stroke();
		// "Front" label at the front edge.
		const front = project(0, -hy - 0.12, base);
		ctx.fillStyle = muted;
		ctx.font = '500 11px "Geist Variable", system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('front', front.sx, front.sy + 4);

		const quads: { pts: { sx: number; sy: number }[]; depth: number; v: number }[] = [];
		const P = model.pts;
		for (let r = 0; r + 1 < P.length; r++) {
			for (let c = 0; c + 1 < P[r].length; c++) {
				const a = P[r][c];
				const b = P[r][c + 1];
				const d = P[r + 1][c + 1];
				const e = P[r + 1][c];
				if (!a || !b || !d || !e) continue;
				const pr = [a, b, d, e].map((p) => project(p.x, p.y, p.z));
				quads.push({ pts: pr, depth: (pr[0].depth + pr[1].depth + pr[2].depth + pr[3].depth) / 4, v: (a.v + b.v + d.v + e.v) / 4 });
			}
		}
		quads.sort((p, q) => p.depth - q.depth);
		ctx.lineJoin = 'round';
		for (const q of quads) {
			ctx.beginPath();
			q.pts.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
			ctx.closePath();
			ctx.fillStyle = meshPalette.color(q.v, center, range);
			ctx.fill();
			ctx.strokeStyle = card;
			ctx.globalAlpha = 0.55;
			ctx.lineWidth = 0.8;
			ctx.stroke();
			ctx.globalAlpha = 1;
		}
		// Stalks from the plate to single-row/column meshes would be noise; the probe points as dots instead.
		if (!quads.length) {
			for (const row of P)
				for (const p of row) {
					if (!p) continue;
					const s = project(p.x, p.y, p.z);
					ctx.beginPath();
					ctx.arc(s.sx, s.sy, 4, 0, Math.PI * 2);
					ctx.fillStyle = meshPalette.color(p.v, center, range);
					ctx.fill();
				}
		}
	}

	$effect(() => {
		void [mesh, center, range, yaw, elev, zoom, width, height, meshPalette.stops, model];
		draw();
	});

	// Pointer: one finger/button rotates, two pinch-zoom.
	const pointers = new Map<number, { x: number; y: number }>();
	let pinch = 0;
	function down(e: PointerEvent) {
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 2) pinch = dist();
	}
	function dist() {
		const [a, b] = [...pointers.values()];
		return Math.hypot(a.x - b.x, a.y - b.y);
	}
	function move(e: PointerEvent) {
		const prev = pointers.get(e.pointerId);
		if (!prev) return;
		const dx = e.clientX - prev.x;
		const dy = e.clientY - prev.y;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size >= 2) {
			const d = dist();
			if (pinch > 0) zoom = clamp((zoom * d) / pinch, 0.5, 3);
			pinch = d;
			return;
		}
		yaw -= dx * 0.01;
		elev = clamp(elev + dy * 0.008, 0.05, Math.PI / 2);
	}
	function up(e: PointerEvent) {
		pointers.delete(e.pointerId);
		pinch = pointers.size === 2 ? dist() : 0;
	}
	function key(e: KeyboardEvent) {
		const step = 0.15;
		if (e.key === 'ArrowLeft') yaw += step;
		else if (e.key === 'ArrowRight') yaw -= step;
		else if (e.key === 'ArrowUp') elev = clamp(elev + step, 0.05, Math.PI / 2);
		else if (e.key === 'ArrowDown') elev = clamp(elev - step, 0.05, Math.PI / 2);
		else if (e.key === '+' || e.key === '=') zoom = clamp(zoom * 1.15, 0.5, 3);
		else if (e.key === '-') zoom = clamp(zoom / 1.15, 0.5, 3);
		else if (e.key === '0') reset();
		else return;
		e.preventDefault();
	}
	// Wheel zoom needs a non-passive listener to keep the page from scrolling.
	$effect(() => {
		const cv = canvas;
		if (!cv) return;
		const onwheel = (e: WheelEvent) => {
			e.preventDefault();
			zoom = clamp(zoom * Math.exp(-e.deltaY * 0.0015), 0.5, 3);
		};
		cv.addEventListener('wheel', onwheel, { passive: false });
		return () => cv.removeEventListener('wheel', onwheel);
	});
</script>

<div class="relative w-full" bind:clientWidth={width} data-testid="mesh-surface">
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		class="cursor-grab rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
		style="touch-action: pan-y"
		tabindex="0"
		role="application"
		aria-label="{label}. Drag or use the arrow keys to rotate, wheel or +/− to zoom."
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		ondblclick={reset}
		onkeydown={key}
	>
		<canvas bind:this={canvas} style="width:100%; height:{height}px" class="block" aria-hidden="true"></canvas>
	</div>
	<div class="pointer-events-none absolute top-1 left-1 text-[0.6875rem] text-muted-foreground">Height exaggerated · ±{fmtZ(range, 3, false)} mm</div>
	<button type="button" class="btn btn-ghost btn-icon btn-sm absolute top-0 right-0" title="Reset view" aria-label="Reset view" onclick={reset}><RotateCcw /></button>
</div>
