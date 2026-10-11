<script lang="ts">
	/**
	 * In the printer settings dialog: says where the Bed tab comes from when the Bed
	 * Visualizer plugin isn't on this OctoPrint (nothing when it is, or when unknown).
	 */
	import { Grid3x3 } from '@lucide/svelte';
	import { bedMesh } from '#lib/client/bedmesh.svelte.ts';

	let { printerId }: { printerId: string } = $props();
	let missing = $state(false);

	$effect(() => {
		const id = printerId;
		missing = false;
		bedMesh.load(id).then(
			(d) => id === printerId && (missing = !d.plugin.installed && !d.plugin.error),
			() => {}
		);
	});
</script>

{#if missing}
	<div class="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5" data-testid="bedmesh-hint">
		<Grid3x3 class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
		<p class="text-[0.6875rem] text-muted-foreground">
			<span class="text-[0.8125rem] font-medium text-foreground">Bed mesh</span><br />
			Install the <span class="font-medium text-foreground">Bed Visualizer</span> plugin (OctoPrint-BedLevelVisualizer) from OctoPrint’s Plugin Manager to get a Bed tab with the mesh, its history and drift alerts.
		</p>
	</div>
{/if}
