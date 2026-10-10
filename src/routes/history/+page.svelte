<script lang="ts">
	import PageHeader from '#lib/components/PageHeader.svelte';
	import HistoryView from '#lib/components/history/HistoryView.svelte';
</script>

<svelte:head><title>History · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="History" description="Every print on every printer: how it ended, how long it took and what it used." />
	<div class="px-8 pb-10">
		<HistoryView />
	</div>
</div>
