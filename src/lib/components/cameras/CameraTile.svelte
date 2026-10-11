<script lang="ts">
	import { Camera, ExternalLink, Thermometer, VideoOff } from '@lucide/svelte';
	import StateDot from '../printer/StateDot.svelte';
	import { snapshotUrl, streamUrl, visible, webcamTransform, type CameraInfo } from '#lib/client/webcam.ts';
	import { formatDuration, formatTemp, heaterKeys, heaterLabel, progressPercent, STATE_LABEL, type LiveSnapshot } from '#lib/printer.ts';
	import type { Printer } from '#lib/types.ts';

	/**
	 * One camera on the wall: a live MJPEG stream or a snapshot refreshed every `every`
	 * seconds, only while it's on screen, the tab is visible and `active` is set. The
	 * printer's name, state, progress and temperatures sit on top of the picture.
	 */
	let {
		printer,
		cam,
		snapshot,
		live,
		every,
		active = true,
		fill = false,
		multi = false,
		big = false,
		onopen,
		class: cls = ''
	}: {
		printer: Printer;
		cam: CameraInfo;
		snapshot: LiveSnapshot | undefined;
		/** Stream live (MJPEG); otherwise refresh snapshots. */
		live: boolean;
		/** Snapshot interval, seconds. */
		every: number;
		/** False pauses the camera (e.g. another tile is open full screen). */
		active?: boolean;
		fill?: boolean;
		/** The printer has more than one camera: show the camera's name. */
		multi?: boolean;
		/** Larger overlay text (full screen, kiosk). */
		big?: boolean;
		onopen?: () => void;
		class?: string;
	} = $props();

	/** Removing a streaming <img> doesn't always end its request; pointing it elsewhere does. */
	function endStream(node: HTMLImageElement) {
		return {
			destroy() {
				node.removeAttribute('src');
				node.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
			}
		};
	}

	let shown = $state(false);
	let failed = $state(false);
	let attempt = $state(0);
	/** The snapshot on screen, and the next one loading behind it (no flicker). */
	let frame = $state<string | null>(null);

	const running = $derived(shown && active);
	const canStream = $derived(cam.proxied && cam.stream === 'mjpeg');
	const streaming = $derived(live && canStream && !failed);
	const src = $derived(running && streaming ? `${streamUrl(printer.id, cam.id)}&n=${attempt}` : null);

	// Snapshots: preload each frame, swap when it's ready; retry with backoff after errors.
	$effect(() => {
		if (!running || streaming || !cam.snapshot) return;
		let stop = false;
		let timer: ReturnType<typeof setTimeout>;
		let misses = 0;
		const next = () => {
			const url = snapshotUrl(printer.id, cam.id);
			const img = new Image();
			img.onload = () => {
				if (stop) return;
				misses = 0;
				frame = url;
				timer = setTimeout(next, every * 1000);
			};
			img.onerror = () => {
				if (stop) return;
				misses++;
				timer = setTimeout(next, Math.min(60, every * 2 ** Math.min(misses, 4)) * 1000);
			};
			img.src = url;
		};
		next();
		return () => {
			stop = true;
			clearTimeout(timer);
		};
	});

	// A broken stream falls back to snapshots, and tries streaming again a minute later.
	$effect(() => {
		if (!failed) return;
		const t = setTimeout(() => {
			failed = false;
			attempt++;
		}, 60_000);
		return () => clearTimeout(t);
	});

	const s = $derived(snapshot);
	const pct = $derived(s ? progressPercent(s) : null);
	const temps = $derived(s ? heaterKeys(s.temps).filter((k) => s.temps[k].actual != null) : []);
	const toolCount = $derived(temps.filter((k) => k.startsWith('tool')).length);
</script>

<div
	use:visible={(v) => (shown = v)}
	class="group relative isolate overflow-hidden bg-black text-white {cls}"
	data-testid="camera-tile"
	data-printer={printer.id}
	data-camera={cam.id}
	data-live={src ? 'stream' : frame ? 'snapshot' : 'idle'}
>
	<button class="absolute inset-0 z-0 block size-full cursor-pointer" aria-label="Open {printer.name}{multi ? ` – ${cam.label}` : ''} full screen" onclick={onopen}>
		{#if src}
			<img {src} use:endStream alt="{printer.name} live" class="size-full {fill ? 'object-cover' : 'object-contain'}" style:transform={webcamTransform(cam)} onerror={(e) => e.currentTarget.isConnected && (failed = true)} />
		{:else if frame && (!streaming || !running)}
			<img src={frame} alt="{printer.name} snapshot" class="size-full {fill ? 'object-cover' : 'object-contain'} {running ? '' : 'opacity-70'}" style:transform={webcamTransform(cam)} />
		{:else if !cam.snapshot && !canStream}
			<span class="grid size-full place-items-center px-4 text-center">
				<span>
					<VideoOff class="mx-auto size-6 opacity-70" />
					<span class="mt-2 block text-[13px]">{cam.stream?.toUpperCase() ?? 'This'} stream can’t be relayed</span>
				</span>
			</span>
		{:else}
			<span class="grid size-full place-items-center"><Camera class="size-6 animate-pulse opacity-50" /></span>
		{/if}
	</button>

	<!-- Overlay: never blocks the tap target except for its own links. -->
	<div class="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start gap-2 bg-gradient-to-b from-black/65 to-transparent p-2.5 {big ? 'sm:p-4' : ''}">
		<div class="flex min-w-0 items-center gap-2 rounded-md bg-black/35 px-2 py-1 backdrop-blur-sm">
			<StateDot state={s?.state} />
			<span class="truncate font-semibold {big ? 'text-[15px]' : 'text-[13px]'}">{printer.name}</span>
			{#if multi}<span class="truncate text-[11px] opacity-75">· {cam.label}</span>{/if}
		</div>
		<span class="ml-auto shrink-0 rounded-md bg-black/35 px-2 py-1 text-[11px] backdrop-blur-sm">
			{#if src}<span class="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-red-500 align-middle"></span>live{:else if frame}every {every}s{:else}{s ? STATE_LABEL[s.state] : '…'}{/if}
		</span>
		{#if !canStream && cam.externalUrl}
			<a class="pointer-events-auto shrink-0 rounded-md bg-black/45 p-1.5" href={cam.externalUrl} target="_blank" rel="noreferrer" title="Open the stream directly" aria-label="Open stream"><ExternalLink class="size-3.5" /></a>
		{/if}
	</div>

	<div class="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/75 via-black/40 to-transparent px-2.5 pt-8 pb-2.5 {big ? 'sm:px-4 sm:pb-4' : ''}">
		{#if pct != null}
			<div class="flex items-baseline gap-2 {big ? 'text-[15px]' : 'text-[13px]'}">
				<span class="font-semibold tabular-nums" data-testid="camera-progress">{Math.round(pct)}%</span>
				{#if s?.job?.file}<span class="min-w-0 truncate text-[11px] opacity-80">{s.job.file.display}</span>{/if}
				{#if s?.progress?.printTimeLeft != null}<span class="ml-auto shrink-0 font-mono text-[11px] opacity-80">{formatDuration(s.progress.printTimeLeft)} left</span>{/if}
			</div>
			<div class="mt-1.5 h-1 overflow-hidden rounded-full bg-white/20">
				<div class="h-full rounded-full transition-[width] duration-700 {s?.state === 'paused' ? 'bg-warning' : 'bg-primary'}" style="width:{pct}%"></div>
			</div>
		{/if}
		{#if temps.length}
			<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums opacity-90">
				<Thermometer class="size-3 self-center opacity-70" />
				{#each temps as k (k)}
					{@const t = s!.temps[k]}
					<span>{heaterLabel(k, toolCount)} {formatTemp(t.actual)}{t.target ? ` / ${formatTemp(t.target)}` : ''}</span>
				{/each}
			</div>
		{/if}
	</div>
</div>
