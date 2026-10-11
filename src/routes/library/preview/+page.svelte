<script lang="ts">
	import { page } from '$app/state';
	import { ArrowLeft } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import GcodeViewer from '#lib/components/gcode/GcodeViewer.svelte';
	import { urls } from '#lib/gcode/load.ts';
	import { parentPath } from '#lib/library.ts';

	/** Toolpath preview of a library file: /library/preview?source=<id>&path=<path>[&v=<version>]. */
	const source = $derived(page.url.searchParams.get('source') ?? '');
	const path = $derived(page.url.searchParams.get('path') ?? '');
	const version = $derived(page.url.searchParams.get('v') ?? '');
	const name = $derived(path.split('/').pop() ?? path);
	const backHref = $derived(`/library?source=${encodeURIComponent(source)}&path=${encodeURIComponent(parentPath(path))}`);
</script>

<svelte:head><title>{name} · Preview · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title={name || 'Preview'} description={path ? `Toolpath preview · ${path}` : 'No file chosen'}>
		{#snippet actions()}
			<a class="btn btn-secondary" href={backHref}><ArrowLeft />Library</a>
		{/snippet}
	</PageHeader>
	<div class="px-4 pb-8 sm:px-8">
		{#if source && path}
			{#key `${source}:${path}:${version}`}
				<GcodeViewer url={urls.libraryFile(source, path)} cacheKey="lib:{source}:{path}:{version}" class="h-[calc(100dvh-11rem)] min-h-96" />
			{/key}
		{:else}
			<p class="text-[13px] text-muted-foreground">Pick a file in the Library and choose Preview.</p>
		{/if}
	</div>
</div>
