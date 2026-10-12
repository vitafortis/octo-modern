<script lang="ts">
	import { ChartColumn, History } from '@lucide/svelte';
	import { page } from '$app/state';
	import Segmented from '../Segmented.svelte';

	/** History's two views: the list of prints and the stats. Carries the printer filter across. */
	let { active }: { active: 'prints' | 'stats' } = $props();
	const printer = $derived(page.url.searchParams.get('printer'));
	const q = $derived(printer ? `?printer=${encodeURIComponent(printer)}` : '');
</script>

<Segmented
	label="History views"
	{active}
	items={[
		{ id: 'prints', label: 'Prints', href: `/history${q}`, icon: History },
		{ id: 'stats', label: 'Stats', href: `/history/stats${q}`, icon: ChartColumn }
	]}
/>
