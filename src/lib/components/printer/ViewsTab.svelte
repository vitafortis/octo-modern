<script lang="ts" module>
	import type { Component } from 'svelte';
	import { Camera, Clapperboard, Grid3x3, History, ListOrdered, ScanEye, Wrench } from '@lucide/svelte';
	import WebcamTab from './WebcamTab.svelte';
	import TimelapseTab from './TimelapseTab.svelte';
	import HistoryTab from './HistoryTab.svelte';
	import DetectionTab from './DetectionTab.svelte';
	import QueueTab from './QueueTab.svelte';
	import MaintenanceTab from './MaintenanceTab.svelte';
	import BedMeshTab from './BedMeshTab.svelte';
	import type { TabProps } from './tabs.ts';

	/** What renders each view of the Camera, Jobs and Care tabs, by `<tab>/<view>`. */
	const VIEWS: Record<string, { component: Component<TabProps>; icon: Component }> = {
		'camera/live': { component: WebcamTab, icon: Camera },
		'camera/timelapse': { component: TimelapseTab, icon: Clapperboard },
		'camera/detection': { component: DetectionTab, icon: ScanEye },
		'jobs/history': { component: HistoryTab, icon: History },
		'jobs/queue': { component: QueueTab, icon: ListOrdered },
		'care/maintenance': { component: MaintenanceTab, icon: Wrench },
		'care/bed': { component: BedMeshTab, icon: Grid3x3 }
	};
</script>

<script lang="ts">
	import Segmented from '../Segmented.svelte';
	import { isPending } from '#lib/queue.ts';
	import { queue } from '#lib/client/queue.svelte.ts';

	/** A tab made of views (Camera, Jobs, Care): a segmented switcher when there's more than one, then the open view. */
	let props: TabProps = $props();
	const { printer, tab, view, views = [], openView } = $derived(props);

	const current = $derived(VIEWS[`${tab}/${view}`]);
	// Jobs: how many are waiting for this printer, on the Queue segment.
	const waiting = $derived(tab === 'jobs' ? queue.jobs.filter((j) => j.printerId === printer.id && isPending(j)).length : 0);
	const items = $derived(views.filter((v) => v.segment !== false).map((v) => ({ id: v.id, label: v.label, icon: VIEWS[`${tab}/${v.id}`]?.icon, count: v.id === 'queue' ? waiting : undefined })));
</script>

<div class="space-y-4">
	{#if items.length > 1}
		<Segmented label={`${tab ?? ""} views`} {items} active={view ?? ''} onselect={(id) => openView?.(id === views[0]?.id ? null : id)} />
	{/if}
	{#if current}
		{#key view}
			<current.component {...props} />
		{/key}
	{/if}
</div>
