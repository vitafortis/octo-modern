<script lang="ts">
	import { onMount } from 'svelte';
	import { ChevronDown, Maximize2, Minimize2, SquareTerminal } from '@lucide/svelte';
	import ControlTab from './ControlTab.svelte';
	import TerminalTab from './TerminalTab.svelte';
	import { phone } from '#lib/client/viewport.svelte.ts';
	import type { TabProps } from './tabs.ts';

	/**
	 * The Control tab: jogging, temperatures, fans and custom controls, with the terminal as
	 * a collapsible panel underneath. "Expand" gives the terminal the whole tab
	 * (`?tab=control&view=terminal`, the old Terminal tab).
	 */
	let props: TabProps = $props();
	const expanded = $derived(props.view === 'terminal');

	const KEY = 'ocm-control-terminal';
	// Open by default where there's room; phones start with it folded (it wants the keyboard).
	let open = $state(true);
	onMount(() => {
		try {
			const v = localStorage.getItem(KEY);
			open = v ? v === 'open' : !phone.current;
		} catch {
			open = !phone.current;
		}
	});
	function toggle() {
		open = !open;
		try {
			localStorage.setItem(KEY, open ? 'open' : 'closed');
		} catch {}
	}
</script>

{#if expanded}
	<div class="flex min-h-0 flex-1 flex-col gap-2" data-testid="terminal-expanded">
		<div class="flex items-center gap-2">
			<h2 class="flex items-center gap-2 text-sm font-semibold"><SquareTerminal class="size-4 text-primary" />Terminal</h2>
			<button class="btn btn-ghost btn-sm ml-auto touch:h-11" onclick={() => props.openView?.(null)} title="Back to the controls, with the terminal underneath"><Minimize2 />Collapse</button>
		</div>
		<TerminalTab {...props} />
	</div>
{:else}
	<div class="space-y-4">
		<ControlTab {...props} />
		<section data-testid="terminal-panel">
			<div class="flex items-center gap-1">
				<button class="btn btn-ghost -ml-2 gap-2 px-2 text-sm font-semibold touch:h-11" aria-expanded={open} aria-controls="terminal-panel-body" onclick={toggle}>
					<SquareTerminal class="size-4 text-primary" />Terminal<ChevronDown class="size-4 text-muted-foreground transition-transform {open ? '' : '-rotate-90'}" />
				</button>
				<button class="btn btn-ghost btn-sm ml-auto touch:h-11" onclick={() => props.openView?.('terminal')} title="Give the terminal the whole tab"><Maximize2 />Expand</button>
			</div>
			{#if open}
				<div id="terminal-panel-body" class="mt-2 flex h-[min(30rem,70dvh)] flex-col">
					<TerminalTab {...props} />
				</div>
			{/if}
		</section>
	</div>
{/if}
