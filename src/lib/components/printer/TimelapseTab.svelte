<script lang="ts">
	// PHASE 2 PLACEHOLDER — replace this file's body with the real tab.
	// Props: see TabProps in ./tabs.ts (printer, live, canControl).
	import { Clapperboard } from '@lucide/svelte';
	import TabPlaceholder from './TabPlaceholder.svelte';
	import type { TabProps } from './tabs.ts';

	let { printer }: TabProps = $props();
</script>

<TabPlaceholder icon={Clapperboard} title="Timelapse" description="Rendered timelapses to watch and download, and the timelapse settings." />
