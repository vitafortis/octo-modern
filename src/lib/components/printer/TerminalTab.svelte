<script lang="ts">
	// PHASE 2 PLACEHOLDER — replace this file's body with the real tab.
	// Props: see TabProps in ./tabs.ts (printer, live, canControl).
	import { SquareTerminal } from '@lucide/svelte';
	import TabPlaceholder from './TabPlaceholder.svelte';
	import type { TabProps } from './tabs.ts';

	let { printer }: TabProps = $props();
</script>

<TabPlaceholder icon={SquareTerminal} title="Terminal" description="The live serial log with filters, and a G-code prompt (confirmed while printing)." />
