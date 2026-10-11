<script lang="ts">
	import { page } from '$app/state';
	import { afterNavigate, replaceState } from '$app/navigation';
	import { ChevronLeft, ChevronRight, Expand, LogOut, Monitor, VideoOff, X } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import CameraTile from '#lib/components/cameras/CameraTile.svelte';
	import { cameras, type CameraInfo } from '#lib/client/webcam.ts';
	import { pollStatuses, printers, statuses } from '#lib/client/state.svelte.ts';
	import { EVERY_CHOICES, ROTATE_CHOICES, kioskGrid, parseWallParams, streamsLive, wallQuery, type WallLayout, type WallMode, type WallOptions } from '#lib/cameras.ts';
	import type { Printer } from '#lib/types.ts';

	/**
	 * The camera wall: every webcam the user may see. Options live in the URL (see
	 * src/lib/cameras.ts) so a layout or a kiosk setup can be bookmarked.
	 */
	let opts = $state<WallOptions>(parseWallParams(page.url.searchParams));
	let tiles = $state<{ key: string; printer: Printer; cam: CameraInfo; multi: boolean }[] | null>(null);
	let without = $state(0);
	let focus = $state<string | null>(null);
	let rotateIndex = $state(0);
	let idle = $state(false);
	let landscape = $state(true);
	let focusEl = $state<HTMLElement>();

	// Arriving with other options (a bookmark, the command palette) while already here.
	afterNavigate(() => (opts = parseWallParams(page.url.searchParams)));

	// Keep the URL in step with the options (bookmarkable).
	$effect(() => {
		const q = wallQuery(opts);
		const url = `${page.url.pathname}${q ? `?${q}` : ''}`;
		if (url !== `${page.url.pathname}${page.url.search}`) replaceState(url, {});
	});

	$effect(() => pollStatuses());

	// Cameras of every visible printer (or the ones in ?printers=).
	$effect(() => {
		const list = printers.list.filter((p) => !opts.printers || opts.printers.includes(p.id));
		let stale = false;
		Promise.all(list.map(async (p) => ({ p, cams: await cameras(p.id) }))).then((all) => {
			if (stale) return;
			without = all.filter((a) => !a.cams.length).length;
			tiles = all.flatMap(({ p, cams }) => cams.map((cam) => ({ key: `${p.id}:${cam.id}`, printer: p, cam, multi: cams.length > 1 })));
		});
		return () => (stale = true);
	});

	const rotating = $derived(opts.kiosk && opts.rotate > 0 && (tiles?.length ?? 0) > 1);
	const shownCount = $derived(focus || rotating ? 1 : (tiles?.length ?? 0));
	const live = $derived(streamsLive(opts.mode, shownCount));
	const grid = $derived(kioskGrid(tiles?.length ?? 0, opts.layout, landscape));
	const focused = $derived(tiles?.find((t) => t.key === focus) ?? null);

	// Rotation through cameras (kiosk).
	$effect(() => {
		if (!rotating || focus) return;
		const n = tiles!.length;
		const t = setInterval(() => (rotateIndex = (rotateIndex + 1) % n), opts.rotate * 1000);
		return () => clearInterval(t);
	});

	// Kiosk: keep the screen awake (re-acquired when the tab comes back), hide an idle cursor.
	$effect(() => {
		if (!opts.kiosk) return;
		let lock: WakeLockSentinel | null = null;
		let gone = false;
		const acquire = async () => {
			if (gone || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
			try {
				lock = await navigator.wakeLock.request('screen');
			} catch {
				// Not allowed (no user gesture yet, low battery…): the screen may sleep.
			}
		};
		void acquire();
		document.addEventListener('visibilitychange', acquire);
		return () => {
			gone = true;
			document.removeEventListener('visibilitychange', acquire);
			void lock?.release().catch(() => {});
		};
	});

	$effect(() => {
		if (!opts.kiosk) {
			idle = false;
			return;
		}
		let t: ReturnType<typeof setTimeout>;
		const wake = () => {
			idle = false;
			clearTimeout(t);
			t = setTimeout(() => (idle = true), 3000);
		};
		wake();
		for (const ev of ['mousemove', 'pointerdown', 'keydown']) window.addEventListener(ev, wake);
		return () => {
			clearTimeout(t);
			for (const ev of ['mousemove', 'pointerdown', 'keydown']) window.removeEventListener(ev, wake);
		};
	});

	$effect(() => {
		const mq = matchMedia('(orientation: landscape)');
		landscape = mq.matches;
		const on = () => (landscape = mq.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});

	async function enterKiosk() {
		opts.kiosk = true;
		try {
			await document.documentElement.requestFullscreen?.();
		} catch {}
	}

	function exitKiosk() {
		opts.kiosk = false;
		if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
	}

	function open(key: string) {
		focus = key;
		queueMicrotask(() => {
			if (!opts.kiosk) focusEl?.requestFullscreen?.().catch(() => {});
		});
	}

	function close() {
		focus = null;
		if (document.fullscreenElement && !opts.kiosk) void document.exitFullscreen().catch(() => {});
	}

	function move(d: number) {
		if (!tiles?.length || !focus) return;
		const i = tiles.findIndex((t) => t.key === focus);
		focus = tiles[(i + d + tiles.length) % tiles.length].key;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (focus) close();
			else if (opts.kiosk) exitKiosk();
		} else if (focus && e.key === 'ArrowRight') move(1);
		else if (focus && e.key === 'ArrowLeft') move(-1);
	}

	// Leaving browser fullscreen (Esc) closes the open camera too.
	$effect(() => {
		const on = () => {
			if (!document.fullscreenElement && focus && !opts.kiosk) focus = null;
		};
		document.addEventListener('fullscreenchange', on);
		return () => document.removeEventListener('fullscreenchange', on);
	});

	const LAYOUTS: [WallLayout, string][] = [
		['auto', 'Auto'],
		[1, '1'],
		[2, '2'],
		[3, '3'],
		[4, '4']
	];
	const MODES: [WallMode, string][] = [
		['auto', 'Auto'],
		['live', 'Live'],
		['snapshot', 'Snapshots']
	];
	const COLS: Record<string, string> = { '1': 'sm:grid-cols-1', '2': 'sm:grid-cols-2', '3': 'sm:grid-cols-2 lg:grid-cols-3', '4': 'sm:grid-cols-2 lg:grid-cols-4' };
</script>

<svelte:head><title>Cameras · octo·modern</title></svelte:head>
<svelte:window {onkeydown} />

{#snippet segmented(label: string, value: string | number, choices: [string | number, string][], set: (v: never) => void)}
	<div class="flex items-center gap-2">
		<span class="text-[11px] text-muted-foreground">{label}</span>
		<div class="flex rounded-lg border border-border bg-surface p-0.5" role="radiogroup" aria-label={label}>
			{#each choices as [v, text] (v)}
				<button
					role="radio"
					aria-checked={value === v}
					class="h-8 min-w-9 rounded-md px-2.5 text-xs font-medium transition-colors {value === v ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
					onclick={() => set(v as never)}>{text}</button
				>
			{/each}
		</div>
	</div>
{/snippet}

{#if opts.kiosk}
	<!-- Kiosk: covers the app shell; nothing but cameras. -->
	<div class="fixed inset-0 z-[60] bg-black {idle ? 'cursor-none' : ''}" data-testid="camera-kiosk">
		{#if !tiles}
			<div class="grid size-full place-items-center text-white/60">Loading cameras…</div>
		{:else if !tiles.length}
			<div class="grid size-full place-items-center text-white/60">No cameras.</div>
		{:else if rotating}
			{@const t = tiles[rotateIndex % tiles.length]}
			{#key t.key}
				<CameraTile class="size-full" printer={t.printer} cam={t.cam} snapshot={statuses[t.printer.id]} {live} every={opts.every} fill={opts.fill} multi={t.multi} big onopen={() => {}} />
			{/key}
			<div class="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1.5">
				{#each tiles as x, i (x.key)}<span class="size-1.5 rounded-full {i === rotateIndex % tiles.length ? 'bg-white' : 'bg-white/30'}"></span>{/each}
			</div>
		{:else}
			<div class="grid size-full gap-1" style="grid-template-columns: repeat({grid.cols}, minmax(0, 1fr)); grid-template-rows: repeat({grid.rows}, minmax(0, 1fr));">
				{#each tiles as t (t.key)}
					<CameraTile class="size-full" printer={t.printer} cam={t.cam} snapshot={statuses[t.printer.id]} {live} every={opts.every} fill={opts.fill} multi={t.multi} big={tiles.length <= 2} active={!focus} onopen={() => open(t.key)} />
				{/each}
			</div>
		{/if}
		<button
			class="absolute top-3 right-3 z-20 flex h-11 items-center gap-2 rounded-xl bg-black/60 px-3 text-[13px] text-white backdrop-blur transition-opacity {idle ? 'pointer-events-none opacity-0' : 'opacity-100'}"
			onclick={exitKiosk}
			data-testid="kiosk-exit"><LogOut class="size-4" />Exit kiosk</button
		>
	</div>
{:else}
	<div class="h-full overflow-y-auto">
		<PageHeader title="Cameras" description="Every webcam you can see, live or as refreshing snapshots.">
			{#snippet actions()}
				<button class="btn btn-secondary" onclick={enterKiosk} title="Full-screen wall for a tablet or TV: no chrome, cursor hides, screen stays on"><Monitor />Kiosk</button>
			{/snippet}
		</PageHeader>
		<div class="space-y-4 px-4 pb-8 sm:px-8">
			<div class="flex flex-wrap items-center gap-x-5 gap-y-2">
				<div class="hidden sm:block">{@render segmented('Columns', opts.layout, LAYOUTS, (v) => (opts.layout = v))}</div>
				{@render segmented('Video', opts.mode, MODES, (v) => (opts.mode = v))}
				{#if !live}
					<label class="flex items-center gap-2 text-[11px] text-muted-foreground"
						>Every
						<select class="input h-9 w-auto py-0 text-xs" bind:value={opts.every}>
							{#each [...new Set([...EVERY_CHOICES, opts.every])].sort((a, b) => a - b) as n (n)}<option value={n}>{n} s</option>{/each}
						</select>
					</label>
				{/if}
				<label class="flex items-center gap-2 text-[11px] text-muted-foreground"
					>Kiosk rotation
					<select class="input h-9 w-auto py-0 text-xs" bind:value={opts.rotate}>
						{#each [...new Set([...ROTATE_CHOICES, opts.rotate])].sort((a, b) => a - b) as n (n)}<option value={n}>{n ? `every ${n} s` : 'off'}</option>{/each}
					</select>
				</label>
				<label class="flex items-center gap-2 text-[11px] text-muted-foreground"><input type="checkbox" class="size-4 accent-[var(--primary)]" bind:checked={opts.fill} />Fill tiles</label>
				<span class="text-[11px] text-muted-foreground sm:ml-auto" data-testid="camera-mode">
					{live ? 'Live streams' : `Snapshots every ${opts.every} s`}{opts.mode === 'auto' && !live ? ' (many cameras)' : ''} · paused while the tab is hidden
				</span>
			</div>

			{#if tiles === null}
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					{#each [0, 1] as i (i)}<div class="aspect-video animate-pulse rounded-xl border border-border bg-surface"></div>{/each}
				</div>
			{:else if !tiles.length}
				<div class="card mx-auto max-w-md p-8 text-center">
					<span class="mx-auto grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><VideoOff class="size-5" /></span>
					<p class="mt-3 text-[14px] font-semibold">No cameras</p>
					<p class="mt-1 text-[13px] text-muted-foreground">None of your printers has a webcam. Set one up in OctoPrint, or add a stream URL to the server in octo·modern.</p>
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-3 {opts.layout === 'auto' ? 'sm:grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]' : COLS[String(opts.layout)]}" data-testid="camera-grid">
					{#each tiles as t (t.key)}
						<CameraTile
							class="aspect-video rounded-xl border border-border shadow-surface"
							printer={t.printer}
							cam={t.cam}
							snapshot={statuses[t.printer.id]}
							{live}
							every={opts.every}
							fill={opts.fill}
							multi={t.multi}
							active={!focus}
							onopen={() => open(t.key)}
						/>
					{/each}
				</div>
				{#if without}
					<p class="text-[11px] text-muted-foreground">{without} printer{without === 1 ? '' : 's'} without a webcam not shown.</p>
				{/if}
			{/if}
		</div>
	</div>
{/if}

{#if focused}
	<div bind:this={focusEl} class="fixed inset-0 z-[70] bg-black" role="dialog" aria-modal="true" aria-label="{focused.printer.name} camera" data-testid="camera-focus">
		<CameraTile class="size-full" printer={focused.printer} cam={focused.cam} snapshot={statuses[focused.printer.id]} live={opts.mode !== 'snapshot'} every={Math.min(opts.every, 5)} fill={false} multi={focused.multi} big onopen={close} />
		<button class="absolute top-14 right-3 z-20 grid size-11 place-items-center rounded-xl bg-black/60 text-white backdrop-blur" aria-label="Close" onclick={close} data-testid="camera-close"><X class="size-5" /></button>
		{#if (tiles?.length ?? 0) > 1}
			<button class="absolute top-1/2 left-3 z-20 grid size-11 -translate-y-1/2 place-items-center rounded-xl bg-black/50 text-white backdrop-blur" aria-label="Previous camera" onclick={() => move(-1)}><ChevronLeft class="size-5" /></button>
			<button class="absolute top-1/2 right-3 z-20 grid size-11 -translate-y-1/2 place-items-center rounded-xl bg-black/50 text-white backdrop-blur" aria-label="Next camera" onclick={() => move(1)}><ChevronRight class="size-5" /></button>
		{/if}
		<span class="pointer-events-none absolute top-4 left-1/2 z-20 hidden -translate-x-1/2 items-center gap-1 text-[11px] text-white/60 lg:flex"><Expand class="size-3" />Esc to close · ← → to switch</span>
	</div>
{/if}
