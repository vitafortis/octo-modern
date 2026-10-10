<script lang="ts">
	import { BellRing } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import HistoryView from '#lib/components/history/HistoryView.svelte';
	import NotificationsDialog from '#lib/components/history/NotificationsDialog.svelte';
	import { isAdmin } from '#lib/client/state.svelte.ts';

	let notifications = $state(false);
</script>

<svelte:head><title>History · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="History" description="Every print on every printer: how it ended, how long it took and what it used.">
		{#snippet actions()}
			{#if isAdmin()}
				<button class="btn btn-secondary btn-sm" onclick={() => (notifications = true)}><BellRing />Notifications</button>
			{/if}
		{/snippet}
	</PageHeader>
	<div class="px-8 pb-10">
		<HistoryView />
	</div>
</div>

{#if isAdmin()}<NotificationsDialog bind:open={notifications} />{/if}
