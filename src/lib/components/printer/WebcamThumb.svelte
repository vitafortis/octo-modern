<script lang="ts">
	import { Camera } from '@lucide/svelte';
	import { webcamCaps, webcamTransform, type WebcamCaps } from '#lib/client/webcam.ts';

	/** A webcam frame, refreshed every `everyMs` while visible; renders nothing when there's no webcam. */
	let { printerId, everyMs = 10_000, class: cls = '' }: { printerId: string; everyMs?: number; class?: string } = $props();

	let caps = $state<WebcamCaps | null>(null);
	let stamp = $state(Date.now());
	let ok = $state<boolean | null>(null);

	$effect(() => {
		const id = printerId;
		caps = null;
		ok = null;
		webcamCaps(id).then((c) => {
			if (id === printerId) caps = c;
		});
	});

	$effect(() => {
		const t = setInterval(() => {
			if (ok && document.visibilityState === 'visible') stamp = Date.now();
		}, everyMs);
		return () => clearInterval(t);
	});
</script>

{#if caps?.snapshot && ok !== false}
	<div class="relative overflow-hidden bg-black/80 {cls} {ok ? '' : 'hidden'}">
		<img
			src="/api/printers/{printerId}/webcam/snapshot?t={stamp}"
			alt="Webcam"
			class="h-full w-full object-cover"
			style:transform={webcamTransform(caps)}
			onload={() => (ok = true)}
			onerror={() => (ok = ok ? true : false)}
		/>
		<span class="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] text-white/90"><Camera class="size-3" />live</span>
	</div>
{/if}
