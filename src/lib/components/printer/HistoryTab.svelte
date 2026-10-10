<script lang="ts">
	// PHASE 2 PLACEHOLDER — replace this file's body with the real tab.
	// Props: see TabProps in ./tabs.ts (printer, live, canControl).
	import { History } from '@lucide/svelte';
	import TabPlaceholder from './TabPlaceholder.svelte';
	import type { TabProps } from './tabs.ts';

	let { printer }: TabProps = $props();
</script>

<TabPlaceholder icon={History} title="History" description="Past prints with their outcome, duration and filament used." />
