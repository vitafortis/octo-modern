<script lang="ts">
	import WebcamView from './WebcamView.svelte';
	import type { TabProps } from './tabs.ts';

	let { printer }: TabProps = $props();
</script>

<div class="mx-auto max-w-6xl">
	<WebcamView printerId={printer.id} class="w-full" />
	<p class="mt-3 text-xs text-muted-foreground">
		The stream is relayed through octo·modern, so it works wherever octo·modern does; it pauses while this page is hidden. Flip and rotation follow OctoPrint’s webcam settings.
	</p>
</div>
