<script lang="ts">
	// PHASE 2 PLACEHOLDER — replace this file's body with the real tab.
	// Props: see TabProps in ./tabs.ts (printer, live, canControl).
	import { Move } from '@lucide/svelte';
	import TabPlaceholder from './TabPlaceholder.svelte';
	import type { TabProps } from './tabs.ts';

	let { printer }: TabProps = $props();
</script>

<TabPlaceholder icon={Move} title="Control" description="Jog the axes, home, extrude and retract, fan and motor controls, and OctoPrint's custom controls." />
