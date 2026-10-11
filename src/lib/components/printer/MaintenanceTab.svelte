<script lang="ts">
	import { onMount } from 'svelte';
	import MaintenancePanel from '../maintenance/MaintenancePanel.svelte';
	import MaintenanceLog from '../maintenance/MaintenanceLog.svelte';
	import { printerMaintenance } from '#lib/client/spools.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import type { MaintenanceLogEntry, MaintenanceTask } from '#lib/spools.ts';
	import type { TabProps } from './tabs.ts';

	let { printer, canControl }: TabProps = $props();
	let tasks = $state<MaintenanceTask[]>([]);
	let log = $state<MaintenanceLogEntry[]>([]);
	let loaded = $state(false);
	let error = $state('');

	async function load() {
		try {
			({ tasks, log } = await printerMaintenance(printer.id));
			error = '';
		} catch (err) {
			error = errorMessage(err);
		} finally {
			loaded = true;
		}
	}
	onMount(() => void load());
</script>

<div class="mx-auto max-w-4xl space-y-5">
	{#if error}
		<div class="card px-4 py-6 text-center text-xs text-danger">{error}</div>
	{:else if loaded}
		<MaintenancePanel printerId={printer.id} printerName={printer.name} {tasks} {canControl} onchange={load} />
		<MaintenanceLog {log} />
	{/if}
</div>
