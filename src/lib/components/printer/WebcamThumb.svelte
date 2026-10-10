<script lang="ts">
	import { Camera } from '@lucide/svelte';
	import { cameras, snapshotUrl, visible, webcamTransform, type CameraInfo } from '#lib/client/webcam.ts';

	/**
	 * A webcam snapshot, refreshed every `everyMs` while it's on screen and the tab is
	 * visible; renders nothing when the printer has no camera with snapshots.
	 */
	let { printerId, everyMs = 10_000, class: cls = '' }: { printerId: string; everyMs?: number; class?: string } = $props();

	let cam = $state<CameraInfo | null>(null);
	let stamp = $state(Date.now());
	let ok = $state<boolean | null>(null);
	let shown = $state(false);

	$effect(() => {
		const id = printerId;
		cam = null;
		ok = null;
		cameras(id).then((list) => {
			if (id === printerId) cam = list.find((c) => c.snapshot) ?? null;
		});
	});

	$effect(() => {
		if (!shown || !cam) return;
		stamp = Date.now();
		const t = setInterval(() => (stamp = Date.now()), everyMs);
		return () => clearInterval(t);
	});
</script>

{#if cam && ok !== false}
	<div use:visible={(v) => (shown = v)} class="relative overflow-hidden bg-black/80 {cls} {ok ? '' : 'opacity-0'}">
		{#if shown || ok}
			<img src={snapshotUrl(printerId, cam.id, stamp)} alt="Webcam" class="h-full w-full object-cover" style:transform={webcamTransform(cam)} onload={() => (ok = true)} onerror={() => (ok = ok ? true : false)} />
		{/if}
		<span class="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] text-white/90"><Camera class="size-3" />{cam.label}</span>
	</div>
{/if}
