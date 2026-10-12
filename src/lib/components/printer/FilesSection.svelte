<script lang="ts">
	import FilesTab from './FilesTab.svelte';
	import PreviewTab from './PreviewTab.svelte';
	import type { TabProps } from './tabs.ts';

	/**
	 * The Files tab: the file list, and the toolpath preview of a file or the current job
	 * as a sub-view (`?tab=files&view=preview[&file=…]`) with a way back. The list stays
	 * mounted underneath, so its folder, search and sort survive a look at a preview.
	 */
	let props: TabProps = $props();
	const preview = $derived(props.view === 'preview');
</script>

{#if preview}<PreviewTab {...props} />{/if}
<div class={preview ? 'hidden' : ''}><FilesTab {...props} /></div>
