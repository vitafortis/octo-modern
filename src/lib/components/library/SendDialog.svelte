<script lang="ts">
	import { CircleCheck, CircleX, Folder, LoaderCircle, Play, Send } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import Switch from '../Switch.svelte';
	import StateDot from '../printer/StateDot.svelte';
	import { cancelSend, followSend, sendToPrinter } from '#lib/client/library.ts';
	import { listFiles } from '#lib/client/files.ts';
	import { printers, statuses, toast } from '#lib/client/state.svelte.ts';
	import { bytes } from '#lib/client/format.ts';
	import { STATE_LABEL, formatDuration } from '#lib/printer.ts';
	import type { LibraryEntry, LibrarySend, LibrarySourceSummary } from '#lib/library.ts';
	import type { FileEntry } from '#lib/types.ts';

	let {
		open = $bindable(false),
		source,
		entry,
		printerId = null,
		print: printInitially = false,
		folder: folderInitially = '',
		onsent
	}: {
		open: boolean;
		source: LibrarySourceSummary;
		entry: LibraryEntry;
		/** Preselected printer (e.g. from a printer's Files tab). */
		printerId?: string | null;
		print?: boolean;
		folder?: string;
		onsent?: (s: LibrarySend) => void;
	} = $props();

	/** Printers this source may send to, which the user controls. */
	const targets = $derived(printers.list.filter((p) => p.access?.control && source.printers.includes(p.id)));

	let target = $state<string | null>(null);
	let folder = $state('');
	let print = $state(false);
	let folders = $state<string[]>([]);
	let send = $state<LibrarySend | null>(null);
	let busy = $state(false);

	// Reset whenever the dialog opens.
	$effect(() => {
		if (!open) return;
		send = null;
		busy = false;
		print = printInitially;
		folder = folderInitially;
		const single = targets.length === 1 ? targets[0].id : null;
		target = printerId && targets.some((p) => p.id === printerId) ? printerId : single;
	});

	// OctoPrint's folders on the chosen printer.
	$effect(() => {
		const id = target;
		folders = [];
		if (!id || !open) return;
		listFiles(id)
			.then((l) => {
				const out: string[] = [];
				const walk = (list: FileEntry[]) => list.forEach((f) => f.origin === 'local' && f.type === 'folder' && (out.push(f.path), walk(f.children ?? [])));
				walk(l.files);
				if (target === id) folders = out.sort((a, b) => a.localeCompare(b));
			})
			.catch(() => {});
	});

	const chosen = $derived(targets.find((p) => p.id === target));
	const pstate = $derived(target ? statuses[target]?.state : undefined);
	const canPrintNow = $derived(pstate === 'operational');
	const pct = $derived(send && send.size ? Math.min(100, Math.round((send.sent / send.size) * 100)) : 0);

	async function go() {
		if (!chosen) return;
		busy = true;
		const s = await sendToPrinter(source.id, { path: entry.path, printerId: chosen.id, printerName: chosen.name, folder, print });
		if (!s) {
			busy = false;
			return;
		}
		send = s;
		try {
			const final = await followSend(s.id, (u) => (send = u));
			if (final.state === 'done') {
				toast('success', final.preparing ? `Sent; preparing ${final.printerName}` : final.printing ? `Printing on ${final.printerName}` : `Sent to ${final.printerName}`, final.preparing ? `${final.storedPath ?? entry.name} starts once the pre-print steps have finished.` : (final.storedPath ?? entry.name));
				onsent?.(final);
				open = false;
			}
		} catch {
			// Polling failed (signed out, server restarted): the transfer may still finish.
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title="Send to printer" description={entry.name} width="max-w-xl">
	{#if send}
		<div class="space-y-3 py-2" data-testid="send-progress">
			<div class="flex items-center gap-2 text-[0.8125rem]">
				{#if send.state === 'done'}<CircleCheck class="size-4 text-success" />{:else if send.state === 'error' || send.state === 'aborted'}<CircleX class="size-4 text-danger" />{:else}<LoaderCircle class="size-4 animate-spin text-primary" />{/if}
				<span class="font-medium">
					{#if send.state === 'sending'}Sending to {send.printerName}…{:else if send.state === 'processing'}{send.printerName} is saving the file…{:else if send.state === 'done'}Done{:else if send.state === 'aborted'}Cancelled{:else}Failed{/if}
				</span>
				<span class="ml-auto font-mono text-[0.6875rem] text-muted-foreground tabular-nums">{bytes(send.sent)} / {bytes(send.size)}</span>
			</div>
			<div class="h-2 overflow-hidden rounded-full bg-muted">
				<div class="h-full rounded-full transition-[width] duration-300 {send.state === 'error' ? 'bg-danger' : 'bg-primary'}" style="width:{pct}%"></div>
			</div>
			{#if send.error}<p class="text-xs text-danger">{send.error}</p>{/if}
			<p class="text-[0.6875rem] text-muted-foreground">Streams from {source.name} straight into OctoPrint. It keeps going if you close this.</p>
		</div>
	{:else if !targets.length}
		<p class="py-4 text-[0.8125rem] text-muted-foreground">There's no printer you can send {source.name}’s files to.</p>
	{:else}
		<div class="space-y-4">
			<div>
				<span class="label">Printer</span>
				<div class="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="Printer">
					{#each targets as p (p.id)}
						{@const st = statuses[p.id]?.state}
						<button
							type="button"
							role="radio"
							aria-checked={target === p.id}
							class="flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors {target === p.id ? 'border-primary/50 bg-primary-soft' : 'border-border hover:bg-accent/50'}"
							onclick={() => (target = p.id)}
						>
							<StateDot state={st} />
							<span class="min-w-0 flex-1">
								<span class="block truncate text-[0.8125rem] font-medium">{p.name}</span>
								<span class="block text-[0.6875rem] text-muted-foreground">{st ? STATE_LABEL[st] : '…'}</span>
							</span>
						</button>
					{/each}
				</div>
			</div>
			<div class="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
				<div>
					<label class="label" for="send-folder">Folder on OctoPrint</label>
					<div class="relative">
						<Folder class="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
						<select id="send-folder" class="input pl-9" bind:value={folder} disabled={!target}>
							<option value="">Top level</option>
							{#each folders as f (f)}<option value={f}>{f}</option>{/each}
							{#if folder && !folders.includes(folder)}<option value={folder}>{folder}</option>{/if}
						</select>
					</div>
				</div>
				<label class="flex h-9 items-center gap-2 text-[0.8125rem]">
					<Switch label="Start printing" bind:checked={print} />Start printing
				</label>
			</div>
			<div class="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
				<span class="font-mono tabular-nums">{bytes(entry.size)}</span>
				{#if entry.meta?.estimatedTime != null}<span>· {formatDuration(entry.meta.estimatedTime)}</span>{/if}
				{#if entry.meta?.filamentType}<span>· {entry.meta.filamentType}</span>{/if}
				{#if print && chosen && pstate && !canPrintNow}
					<span class="ml-auto text-warning">{chosen.name} is {STATE_LABEL[pstate].toLowerCase()}: it will only be sent.</span>
				{/if}
			</div>
		</div>
	{/if}
	{#snippet footer()}
		{#if send && (send.state === 'sending' || send.state === 'processing')}
			<button class="btn btn-ghost" onclick={() => cancelSend(send!.id)} disabled={send.state === 'processing'}>Cancel transfer</button>
			<button class="btn btn-secondary" onclick={() => (open = false)}>Hide</button>
		{:else if send}
			<button class="btn btn-secondary" onclick={() => (open = false)}>Close</button>
		{:else}
			<button class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
			<button class="btn btn-primary" disabled={!chosen || busy} onclick={go}>
				{#if busy}<LoaderCircle class="animate-spin" />{:else if print}<Play />{:else}<Send />{/if}{print ? 'Send & print' : 'Send'}
			</button>
		{/if}
	{/snippet}
</Dialog>
