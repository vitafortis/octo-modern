<script lang="ts">
	import { CircleCheck, CircleX, LoaderCircle, Play, Send } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import Switch from '../Switch.svelte';
	import LibraryBrowser from './LibraryBrowser.svelte';
	import { cancelSend, followSend, sendToPrinter } from '#lib/client/library.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { bytes } from '#lib/client/format.ts';
	import { formatDuration } from '#lib/printer.ts';
	import { isPrintable, type LibraryEntry, type LibrarySend, type LibrarySourceSummary } from '#lib/library.ts';

	let {
		open = $bindable(false),
		sources,
		printerId,
		printerName,
		folder,
		onsent
	}: {
		open: boolean;
		/** Sources this printer may use. */
		sources: LibrarySourceSummary[];
		printerId: string;
		printerName: string;
		/** OctoPrint folder the file goes to. */
		folder: string;
		onsent?: (s: LibrarySend) => void;
	} = $props();

	let sourceId = $state('');
	let path = $state('');
	let selected = $state<LibraryEntry | null>(null);
	let print = $state(false);
	let send = $state<LibrarySend | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		send = null;
		busy = false;
		if (!sources.some((s) => s.id === sourceId)) {
			let remembered = '';
			try {
				remembered = localStorage.getItem('ocm-library-source') ?? '';
			} catch {}
			sourceId = sources.find((s) => s.id === remembered)?.id ?? sources[0]?.id ?? '';
			path = '';
		}
	});

	const pct = $derived(send && send.size ? Math.min(100, Math.round((send.sent / send.size) * 100)) : 0);
	const ready = $derived(!!selected && selected.type === 'file' && isPrintable(selected.name));

	async function go(entry = selected) {
		if (!entry || busy) return;
		busy = true;
		const s = await sendToPrinter(sourceId, { path: entry.path, printerId, printerName, folder, print });
		if (!s) {
			busy = false;
			return;
		}
		send = s;
		try {
			const final = await followSend(s.id, (u) => (send = u));
			if (final.state === 'done') {
				toast('success', final.preparing ? 'Sent; preparing the printer' : final.printing ? 'Sent and printing' : 'Sent from the library', final.storedPath ?? entry.name);
				onsent?.(final);
				open = false;
			}
		} catch {
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title="Print from the library" description="Pick G-code on your NAS; it’s copied to {printerName}{folder ? ` / ${folder}` : ''}." width="max-w-4xl">
	{#if send}
		<div class="space-y-3 py-6" data-testid="send-progress">
			<div class="flex items-center gap-2 text-[0.8125rem]">
				{#if send.state === 'done'}<CircleCheck class="size-4 text-success" />{:else if send.state === 'error' || send.state === 'aborted'}<CircleX class="size-4 text-danger" />{:else}<LoaderCircle class="size-4 animate-spin text-primary" />{/if}
				<span class="font-medium">{send.path.split('/').pop()}</span>
				<span class="ml-auto font-mono text-[0.6875rem] text-muted-foreground tabular-nums">{send.state === 'processing' ? 'OctoPrint is saving…' : `${bytes(send.sent)} / ${bytes(send.size)}`}</span>
			</div>
			<div class="h-2 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-primary transition-[width] duration-300 {send.state === 'error' ? 'bg-danger' : ''}" style="width:{pct}%"></div></div>
			{#if send.error}<p class="text-xs text-danger">{send.error}</p>{/if}
		</div>
	{:else if sourceId}
		<LibraryBrowser {sources} bind:sourceId bind:path bind:selected compact onopen={(e) => go(e)} />
	{/if}
	{#snippet footer()}
		{#if send && (send.state === 'sending' || send.state === 'processing')}
			<button class="btn btn-ghost mr-auto" disabled={send.state === 'processing'} onclick={() => cancelSend(send!.id)}>Cancel transfer</button>
			<button class="btn btn-secondary" onclick={() => (open = false)}>Hide</button>
		{:else if send}
			<button class="btn btn-secondary" onclick={() => (send = null)}>Back</button>
		{:else}
			<span class="mr-auto min-w-0 truncate text-xs text-muted-foreground">
				{#if selected}{selected.name} · {bytes(selected.size)}{selected.meta?.estimatedTime != null ? ` · ${formatDuration(selected.meta.estimatedTime)}` : ''}{:else}Select a file{/if}
			</span>
			<label class="flex items-center gap-2 text-[0.8125rem]"><Switch label="Start printing" bind:checked={print} />Start printing</label>
			<button class="btn btn-primary" disabled={!ready || busy} onclick={() => go()}>
				{#if busy}<LoaderCircle class="animate-spin" />{:else if print}<Play />{:else}<Send />{/if}{print ? 'Send & print' : 'Send'}
			</button>
		{/if}
	{/snippet}
</Dialog>
