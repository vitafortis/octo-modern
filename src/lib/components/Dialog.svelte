<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from '@lucide/svelte';

	let {
		open = $bindable(false),
		title,
		description,
		width = 'max-w-lg',
		children,
		footer
	}: {
		open: boolean;
		title: string;
		description?: string;
		width?: string;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let dialog: HTMLDialogElement;

	$effect(() => {
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	onclose={() => (open = false)}
	onclick={(e) => e.target === dialog && (open = false)}
	class="m-auto w-[calc(100%-2rem)] {width} rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-surface-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm open:animate-[pop_.16s_ease-out] max-sm:mx-0 max-sm:mt-auto max-sm:mb-0 max-sm:max-h-[calc(var(--app-h,100dvh)-env(safe-area-inset-top)-0.75rem)] max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:open:flex max-sm:open:flex-col max-sm:open:animate-[sheet-up_.22s_cubic-bezier(.2,.8,.2,1)]"
>
	{#if open}
		<!-- On phones: a sheet from the bottom edge, header and actions fixed, the body scrolls. -->
		<div class="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border sm:hidden" aria-hidden="true"></div>
		<div class="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 max-sm:px-4 max-sm:pt-2.5 max-sm:pb-3">
			<div class="min-w-0">
				<h2 class="text-[15px] font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h2>
				{#if description}<p class="mt-0.5 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{description}</p>{/if}
			</div>
			<button class="btn btn-ghost btn-icon btn-sm -mr-1 shrink-0 max-sm:-mt-1" onclick={() => (open = false)} aria-label="Close"><X /></button>
		</div>
		<div class="max-h-[70vh] overflow-y-auto overscroll-contain px-5 py-4 max-sm:max-h-none max-sm:min-h-0 max-sm:flex-1 max-sm:px-4 {footer ? '' : 'max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]'}">
			{@render children()}
		</div>
		{#if footer}
			<div class="flex shrink-0 flex-wrap items-center justify-end gap-2 rounded-b-2xl border-t border-border bg-surface px-5 py-3 max-sm:rounded-none max-sm:px-4 max-sm:pb-safe max-sm:[&>.btn]:flex-1">
				{@render footer()}
			</div>
		{/if}
	{/if}
</dialog>

<style>
	@keyframes -global-pop {
		from {
			opacity: 0;
			transform: translateY(6px) scale(0.98);
		}
	}
</style>
