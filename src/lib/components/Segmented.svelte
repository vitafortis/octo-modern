<script lang="ts" module>
	import type { Component } from 'svelte';

	export interface Segment {
		id: string;
		label: string;
		/** A link (sub-pages) rather than a button. */
		href?: string;
		icon?: Component;
		/** A small count after the label. */
		count?: number;
	}
</script>

<script lang="ts">
	/**
	 * A row of segments for switching between the views of one page or tab: History | Stats,
	 * Live | Timelapses | Failure detection… Links when given `href`, buttons otherwise.
	 */
	let { items, active, onselect, label, class: cls = '' }: { items: Segment[]; active: string; onselect?: (id: string) => void; label: string; class?: string } = $props();
</script>

<div class="scrollbar-none flex max-w-full gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1 max-sm:w-full {cls}" role="tablist" aria-label={label} data-testid="segmented">
	{#each items as s (s.id)}
		{@const on = s.id === active}
		{@const cl = `flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium whitespace-nowrap transition-colors max-sm:flex-1 max-sm:px-2 touch:h-11 ${on ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}`}
		{#if s.href}
			<a href={s.href} role="tab" aria-selected={on} aria-current={on ? 'page' : undefined} class={cl}>
				{#if s.icon}<s.icon class="size-3.5 max-sm:hidden" />{/if}{s.label}{#if s.count}<span class="badge px-1.5 py-0 text-[0.625rem] tabular-nums">{s.count}</span>{/if}
			</a>
		{:else}
			<button type="button" role="tab" aria-selected={on} class={cl} onclick={() => onselect?.(s.id)}>
				{#if s.icon}<s.icon class="size-3.5 max-sm:hidden" />{/if}{s.label}{#if s.count}<span class="badge px-1.5 py-0 text-[0.625rem] tabular-nums">{s.count}</span>{/if}
			</button>
		{/if}
	{/each}
</div>
