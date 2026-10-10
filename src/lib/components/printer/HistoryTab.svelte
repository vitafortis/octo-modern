<script lang="ts">
	import HistoryView from '../history/HistoryView.svelte';
	import type { TabProps } from './tabs.ts';

	let { printer, live }: TabProps = $props();
</script>

<HistoryView printerId={printer.id} {live} />
