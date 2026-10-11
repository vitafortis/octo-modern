<script lang="ts">
	import { LoaderCircle, Save } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import SourceIcon from './SourceIcon.svelte';
	import { saveToLibrary } from '#lib/client/library.ts';
	import type { LibrarySourceSummary } from '#lib/library.ts';
	import type { FileEntry } from '#lib/types.ts';

	let { open = $bindable(false), printerId, file, sources }: { open: boolean; printerId: string; file: FileEntry; sources: LibrarySourceSummary[] } = $props();

	let sourceId = $state('');
	let folder = $state('');
	let busy = $state(false);

	$effect(() => {
		if (open && !sources.some((s) => s.id === sourceId)) sourceId = sources[0]?.id ?? '';
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		const src = sources.find((s) => s.id === sourceId);
		if (!src) return;
		busy = true;
		if (await saveToLibrary(printerId, { path: file.path, sourceId: src.id, sourceName: src.name, folder: folder.trim() })) open = false;
		busy = false;
	}
</script>

<Dialog bind:open title="Save to library" description="Copy {file.display} from OctoPrint to your NAS.">
	<form id="save-library" class="space-y-4" onsubmit={save}>
		<div>
			<span class="label">Source</span>
			<div class="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="Source">
				{#each sources as s (s.id)}
					<button type="button" role="radio" aria-checked={sourceId === s.id} class="flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[0.8125rem] {sourceId === s.id ? 'border-primary/50 bg-primary-soft' : 'border-border hover:bg-accent/50'}" onclick={() => (sourceId = s.id)}>
						<SourceIcon kind={s.kind} class="size-4 text-primary" />{s.name}
					</button>
				{/each}
			</div>
		</div>
		<div>
			<label class="label" for="save-folder">Folder (optional)</label>
			<input id="save-folder" class="input font-mono text-xs" placeholder="e.g. archive/2026" bind:value={folder} />
			<p class="mt-1 text-[0.6875rem] text-muted-foreground">Created if it doesn't exist. The file keeps its name.</p>
		</div>
	</form>
	{#snippet footer()}
		<button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
		<button form="save-library" class="btn btn-primary" disabled={busy || !sourceId}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<Save />{/if}Save</button>
	{/snippet}
</Dialog>
