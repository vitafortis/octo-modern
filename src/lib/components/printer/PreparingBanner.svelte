<script lang="ts">
	import { CircleStop, LoaderCircle } from '@lucide/svelte';
	import { cancelPreparation } from '#lib/client/actions.ts';
	import type { Preparing } from '#lib/preprint.ts';

	let {
		printerId,
		preparing,
		canControl,
		compact = false,
		class: cls = ''
	}: { printerId: string; preparing: Preparing | null | undefined; canControl: boolean; compact?: boolean; class?: string } = $props();

	let now = $state(Date.now());
	$effect(() => {
		if (!preparing) return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});
	const elapsed = $derived(preparing ? Math.max(0, Math.round((now - preparing.startedAt) / 1000)) : 0);
	const clock = $derived(elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s` : `${elapsed}s`);
	let busy = $state(false);

	async function cancel() {
		busy = true;
		await cancelPreparation(printerId, preparing?.file);
		busy = false;
	}
</script>

{#if preparing}
	<div
		class="{cls} flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-primary/30 bg-primary-soft {compact ? 'px-3 py-2 text-xs' : 'px-3.5 py-2.5 text-[0.8125rem]'}"
		data-testid="preparing-{printerId}"
		role="status"
	>
		<LoaderCircle class="size-4 shrink-0 animate-spin text-primary" />
		<div class="min-w-0 flex-1">
			<p class="font-medium">Preparing: {preparing.label.replace(/…$/, '')}</p>
			<p class="truncate text-[0.6875rem] text-muted-foreground" title={preparing.file}>
				{preparing.file} starts when this finishes · {clock}{preparing.by ? ` · started by ${preparing.by}` : ''}
			</p>
		</div>
		{#if canControl}
			<button class="btn btn-danger-outline btn-sm min-h-9" disabled={busy} onclick={cancel}><CircleStop />Cancel</button>
		{/if}
	</div>
{/if}
