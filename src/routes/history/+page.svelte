<script lang="ts">
	import { BellRing } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import HistoryView from '#lib/components/history/HistoryView.svelte';
	import { isAdmin } from '#lib/client/state.svelte.ts';
</script>

<svelte:head><title>History · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="History" description="Every print on every printer: how it ended, how long it took and what it used.">
		{#snippet actions()}
			{#if isAdmin()}
				<a class="btn btn-secondary btn-sm" href="/notifications"><BellRing />Notifications</a>
			{/if}
		{/snippet}
	</PageHeader>
	<div class="page-x pb-10">
		<HistoryView />
	</div>
</div>
