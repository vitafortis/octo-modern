<script lang="ts">
	// PHASE 2 PLACEHOLDER — replace this file's body with the real tab.
	// Props: see TabProps in ./tabs.ts (printer, live, canControl).
	import { FolderOpen } from '@lucide/svelte';
	import TabPlaceholder from './TabPlaceholder.svelte';
	import type { TabProps } from './tabs.ts';

	let { printer }: TabProps = $props();
</script>

<TabPlaceholder icon={FolderOpen} title="Files" description="Upload G-code, browse folders on OctoPrint and the SD card, select and print, and delete files." />
