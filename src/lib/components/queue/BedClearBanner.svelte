<script lang="ts">
	import { BrushCleaning, CirclePause, CirclePlay, LoaderCircle } from '@lucide/svelte';
	import { bedClear, holdPrinter, needsBedClear, queue, queuePrinter } from '#lib/client/queue.svelte.ts';
	import { jobActive, type PrinterState } from '#lib/printer.ts';

	let {
		printerId,
		name,
		state: printerState,
		canControl,
		compact = false,
		class: cls = ''
	}: {
		printerId: string;
		name: string;
		state: PrinterState | undefined;
		canControl: boolean;
		/** Inside an overview card. */
		compact?: boolean;
		class?: string;
	} = $props();

	const q = $derived(queuePrinter(printerId));
	const next = $derived(queue.jobs.find((j) => j.status === 'queued' && (j.printerId === printerId || !j.printerId)));
	const printing = $derived(!!printerState && jobActive(printerState));
	let busy = $state(false);

	async function clear() {
		busy = true;
		await bedClear(printerId, name);
		busy = false;
	}
</script>

{#if q && !printing && (needsBedClear(q) || (q.held && q.waiting > 0))}
	<div
		class="{cls} flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/30 bg-warning/5 {compact ? 'px-3 py-2 text-[12px]' : 'px-3.5 py-2.5 text-[13px]'}"
		data-testid="bed-clear-{printerId}"
	>
		{#if q.held}
			<CirclePause class="size-4 shrink-0 text-warning" />
			<div class="min-w-0 flex-1">
				<p class="font-medium">Queue paused for this printer</p>
				<p class="truncate text-[11px] text-muted-foreground" title={q.heldReason ?? ''}>{q.heldReason ?? 'Paused by hand'}{q.awaitingClear ? ' · the bed needs clearing too' : ''}</p>
			</div>
			{#if canControl}
				{#if q.awaitingClear}<button class="btn btn-secondary btn-sm min-h-9" disabled={busy} onclick={clear}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<BrushCleaning />{/if}Bed is clear</button>{/if}
				<button class="btn btn-secondary btn-sm min-h-9" onclick={() => holdPrinter(printerId, false)}><CirclePlay />Resume</button>
			{/if}
		{:else}
			<BrushCleaning class="size-4 shrink-0 text-warning" />
			<div class="min-w-0 flex-1">
				<p class="font-medium">Clear the bed to continue the queue</p>
				<p class="truncate text-[11px] text-muted-foreground">{q.waiting} job{q.waiting === 1 ? '' : 's'} waiting{next ? ` · next: ${next.name}` : ''}</p>
			</div>
			{#if canControl}
				<button class="btn btn-primary btn-sm min-h-9" disabled={busy} onclick={clear}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<BrushCleaning />{/if}Bed is clear</button>
			{/if}
		{/if}
	</div>
{/if}
