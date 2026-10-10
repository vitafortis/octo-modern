<script lang="ts">
	import { Camera, ExternalLink, Maximize2, RefreshCw, VideoOff } from '@lucide/svelte';
	import { cameras, snapshotUrl, streamUrl, visible, webcamTransform, type CameraInfo } from '#lib/client/webcam.ts';

	/**
	 * A printer's live webcam: the MJPEG stream relayed by octo·modern, a camera switcher
	 * when there are several, fullscreen, and a link for HLS/WebRTC cameras we can't relay.
	 * The stream only runs while the view is on screen and the tab visible.
	 */
	let { printerId, class: cls = '', compact = false, height, onavailable }: { printerId: string; class?: string; compact?: boolean; /** Fixed frame height (CSS), e.g. on the dashboard; default 16:9. */ height?: string; onavailable?: (has: boolean) => void } = $props();

	const frame = $derived(height ? '' : 'aspect-video');

	let list = $state<CameraInfo[] | null>(null);
	let camId = $state<string | null>(null);
	let shown = $state(false);
	let failed = $state(false);
	let attempt = $state(0);
	let box = $state<HTMLElement>();

	$effect(() => {
		const id = printerId;
		list = null;
		cameras(id).then((c) => {
			if (id !== printerId) return;
			list = c;
			camId = c[0]?.id ?? null;
			onavailable?.(c.length > 0);
		});
	});

	const cam = $derived(list?.find((c) => c.id === camId) ?? null);
	// A new src restarts the stream (camera switch, retry, or coming back into view).
	const src = $derived(cam?.proxied && shown && !failed ? `${streamUrl(printerId, cam.id)}&n=${attempt}` : null);

	function retry() {
		failed = false;
		attempt++;
	}

	function fullscreen() {
		if (document.fullscreenElement) void document.exitFullscreen();
		else void box?.requestFullscreen();
	}
</script>

{#if list === null}
	<div class="grid aspect-video place-items-center rounded-xl border border-border bg-surface {cls}"><Camera class="size-5 animate-pulse text-muted-foreground" /></div>
{:else if !list.length}
	{#if !compact}
		<div class="grid aspect-video place-items-center rounded-xl border border-dashed border-border bg-surface px-6 text-center {cls}">
			<div>
				<VideoOff class="mx-auto size-6 text-muted-foreground" />
				<p class="mt-2 text-[13px] font-medium">No webcam</p>
				<p class="mt-1 text-xs text-muted-foreground">Set one up in OctoPrint (Settings → Webcam & Timelapse), or add a stream URL to this server in octo·modern.</p>
			</div>
		</div>
	{/if}
{:else if cam}
	<div bind:this={box} use:visible={(v) => (shown = v)} class="group relative overflow-hidden rounded-xl border border-border bg-black {cls}" style:height>
		{#if cam.proxied}
			{#if src}
				<img
					{src}
					alt="{cam.label} live"
					class="{frame} h-full w-full object-contain"
					style:transform={webcamTransform(cam)}
					onerror={() => (failed = true)}
				/>
			{:else}
				<div class="{frame} h-full w-full"></div>
			{/if}
			{#if failed}
				<div class="absolute inset-0 grid place-items-center bg-black/70 text-center text-white">
					<div>
						<VideoOff class="mx-auto size-6 opacity-80" />
						<p class="mt-2 text-[13px]">The stream stopped or couldn’t start.</p>
						<button class="btn btn-secondary btn-sm mt-3" onclick={retry}><RefreshCw />Retry</button>
					</div>
				</div>
			{/if}
		{:else}
			<!-- HLS / WebRTC: not an image stream, so it can't be relayed. -->
			{#if cam.snapshot && shown}
				<img src={snapshotUrl(printerId, cam.id, attempt)} alt="{cam.label} snapshot" class="{frame} h-full w-full object-contain opacity-60" style:transform={webcamTransform(cam)} />
			{:else}
				<div class="{frame} h-full w-full"></div>
			{/if}
			<div class="absolute inset-0 grid place-items-center text-center text-white">
				<div>
					<p class="text-[13px] font-medium">{cam.stream?.toUpperCase()} stream</p>
					<p class="mt-1 max-w-xs text-xs opacity-80">octo·modern can only relay MJPEG. Open this camera directly (your browser must be able to reach it).</p>
					{#if cam.externalUrl}<a class="btn btn-secondary btn-sm mt-3" href={cam.externalUrl} target="_blank" rel="noreferrer"><ExternalLink />Open stream</a>{/if}
				</div>
			</div>
		{/if}

		<div class="absolute inset-x-0 top-0 flex items-center gap-1.5 bg-gradient-to-b from-black/60 to-transparent p-2 text-white">
			<span class="flex items-center gap-1.5 rounded-md bg-black/40 px-2 py-0.5 text-[11px]">
				{#if cam.proxied && src && !failed}<span class="size-1.5 animate-pulse rounded-full bg-red-500"></span>live{:else}<Camera class="size-3" />{cam.label}{/if}
			</span>
			{#if list.length > 1}
				<div class="ml-1 flex gap-1" role="tablist" aria-label="Cameras">
					{#each list as c (c.id)}
						<button
							role="tab"
							aria-selected={c.id === cam.id}
							class="rounded-md px-2 py-0.5 text-[11px] {c.id === cam.id ? 'bg-white/90 text-black' : 'bg-black/40 text-white hover:bg-black/60'}"
							onclick={() => ((camId = c.id), (failed = false))}>{c.label}</button
						>
					{/each}
				</div>
			{/if}
			<button class="ml-auto rounded-md bg-black/40 p-1 opacity-80 hover:opacity-100" title="Fullscreen" aria-label="Fullscreen" onclick={fullscreen}><Maximize2 class="size-3.5" /></button>
		</div>
	</div>
{/if}
