<script lang="ts">
	import { History } from '@lucide/svelte';
	import { usageLabel, type MaintenanceLogEntry } from '#lib/spools.ts';

	/** What was done when, newest first (a list, so it reads on phones too). */
	let { log, showPrinter = false }: { log: MaintenanceLogEntry[]; showPrinter?: boolean } = $props();
</script>

<section class="card overflow-hidden">
	<h2 class="flex items-center gap-2 border-b border-border px-4 py-3 text-[14px] font-semibold"><History class="size-4 text-primary" />Maintenance log</h2>
	<ul class="divide-y divide-border" data-testid="maintenance-log">
		{#each log as e (e.id)}
			<li class="grid gap-x-4 gap-y-0.5 px-4 py-2.5 text-[13px] sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
				<span class="text-xs text-muted-foreground" title={new Date(e.doneAt).toLocaleString()}>{new Date(e.doneAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
				<div class="min-w-0">
					<p class="truncate font-medium">{e.taskName}{#if showPrinter}<span class="font-normal text-muted-foreground"> · {e.printerName}</span>{/if}</p>
					{#if e.notes}<p class="text-xs whitespace-pre-wrap text-muted-foreground">{e.notes}</p>{/if}
				</div>
				<p class="text-xs text-muted-foreground sm:text-right"><span class="font-mono tabular-nums">{usageLabel(e)}</span>{e.doneBy ? ` · ${e.doneBy}` : ''}</p>
			</li>
		{:else}
			<li class="px-4 py-8 text-center text-xs text-muted-foreground">Nothing done yet. “Done” on a task logs it here, with who and when.</li>
		{/each}
	</ul>
</section>
