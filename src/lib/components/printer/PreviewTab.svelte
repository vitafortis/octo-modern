<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { ArrowLeft, FileCode2, FolderOpen, Crosshair } from '@lucide/svelte';
	import GcodeViewer from '../gcode/GcodeViewer.svelte';
	import { urls } from '#lib/gcode/load.ts';
	import { jobActive } from '#lib/printer.ts';
	import { bytes } from '#lib/client/format.ts';
	import type { TabProps } from './tabs.ts';

	/**
	 * Toolpath preview on the printer page: the current job (following the print live via
	 * progress.filepos) or, with `?file=<path>`, any G-code file in OctoPrint's storage.
	 */
	let { printer, live }: TabProps = $props();

	const s = $derived(live.snapshot);
	const jobFile = $derived(s.job?.file ?? null);
	const picked = $derived(page.url.searchParams.get('file'));
	const pickedVersion = $derived(page.url.searchParams.get('v') ?? '');

	const target = $derived.by(() => {
		if (picked) return { path: picked, origin: 'local', key: `${printer.id}:${picked}:${pickedVersion}`, isJob: jobFile?.origin === 'local' && jobFile.path === picked };
		if (jobFile) return { path: jobFile.path, origin: jobFile.origin, key: `${printer.id}:${jobFile.path}:${jobFile.size ?? ''}:${jobFile.date ?? ''}`, isJob: true };
		return null;
	});
	const isLive = $derived(!!target?.isJob && (jobActive(s.state) || s.state === 'cancelling'));
	const name = $derived(target ? (target.isJob && jobFile ? jobFile.display : target.path.split('/').pop()) : '');

	function back() {
		const url = new URL(page.url.href);
		url.searchParams.delete('file');
		url.searchParams.delete('v');
		goto(url, { replace: true, reset: false });
	}

	function filesTab() {
		const url = new URL(page.url.href);
		url.searchParams.set('tab', 'files');
		url.searchParams.delete('file');
		url.searchParams.delete('v');
		goto(url, { replace: true, reset: false });
	}
</script>

{#if !target}
	<div class="card mx-auto max-w-md p-8 text-center">
		<span class="mx-auto grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><FileCode2 class="size-5" /></span>
		<p class="mt-3 text-[14px] font-semibold">Nothing to preview</p>
		<p class="mt-1 text-[13px] text-muted-foreground">Load or print a file to see its toolpath here, or preview any file from the Files tab.</p>
		<button class="btn btn-primary mt-4" onclick={filesTab}><FolderOpen />Open Files</button>
	</div>
{:else}
	<div class="space-y-3">
		<div class="flex flex-wrap items-center gap-2">
			{#if picked && jobFile && !target.isJob}
				<button class="btn btn-ghost btn-sm -ml-2" onclick={back}><ArrowLeft />Current job</button>
			{/if}
			<FileCode2 class="size-4 shrink-0 text-muted-foreground" />
			<h2 class="min-w-0 truncate text-[14px] font-semibold" title={target.path}>{name}</h2>
			{#if isLive}
				<span class="badge badge-primary"><Crosshair />live</span>
			{:else if target.isJob}
				<span class="badge">current job</span>
			{/if}
			{#if target.isJob && jobFile?.size}<span class="font-mono text-[11px] text-muted-foreground">{bytes(jobFile.size)}</span>{/if}
		</div>
		{#if target.origin !== 'local'}
			<div class="card p-6 text-center text-[13px] text-muted-foreground">This file is on the printer’s SD card; OctoPrint can’t send it to octo·modern, so there’s no preview.</div>
		{:else}
			{#key target.key}
				<GcodeViewer class="h-[max(26rem,calc(100dvh-17rem))]" url={urls.printerFile(printer.id, target.path)} cacheKey={target.key} live={isLive} filepos={isLive ? (s.progress?.filepos ?? null) : null} />
			{/key}
		{/if}
	</div>
{/if}
