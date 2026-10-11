<script lang="ts" module>
	import type { Component } from 'svelte';

	export interface MenuAction {
		label: string;
		icon?: Component;
		onclick: () => unknown;
		danger?: boolean;
		disabled?: boolean;
		/** Why it's disabled, or what it does. */
		hint?: string;
		/** Leave it out of the menu. */
		hidden?: boolean;
	}
</script>

<script lang="ts">
	import { Ellipsis } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';

	/**
	 * A "⋯" button that opens a list of actions for one item: a sheet from the bottom edge on
	 * phones (where the list layouts that use it live), a small dialog elsewhere.
	 */
	let { title, description, actions, label = 'More actions' }: { title: string; description?: string; actions: MenuAction[]; label?: string } = $props();

	let open = $state(false);
	const shown = $derived(actions.filter((a) => !a.hidden));

	function run(a: MenuAction) {
		open = false;
		void a.onclick();
	}
</script>

{#if shown.length}
	<button
		class="btn btn-ghost btn-icon btn-sm shrink-0"
		aria-label="{label}: {title}"
		aria-haspopup="dialog"
		onclick={(e) => {
			e.stopPropagation();
			open = true;
		}}><Ellipsis /></button
	>
	<Dialog bind:open {title} {description} width="max-w-sm">
		<div class="-mx-2 -my-2 flex flex-col" role="menu">
			{#each shown as a (a.label)}
				<button
					role="menuitem"
					class="flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-[15px] transition-colors hover:bg-accent disabled:opacity-45 {a.danger ? 'text-danger' : 'text-foreground'}"
					disabled={a.disabled}
					onclick={() => run(a)}
				>
					{#if a.icon}<a.icon class="size-5 shrink-0 {a.danger ? '' : 'text-muted-foreground'}" />{/if}
					<span class="min-w-0 flex-1">
						{a.label}
						{#if a.hint}<span class="block text-xs text-muted-foreground">{a.hint}</span>{/if}
					</span>
				</button>
			{/each}
		</div>
	</Dialog>
{/if}
