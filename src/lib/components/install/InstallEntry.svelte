<script lang="ts">
	import { Download, X } from '@lucide/svelte';
	import { dismissInstall, install, startInstall } from '#lib/client/install.svelte.ts';

	let { rail = false }: { rail?: boolean } = $props();
</script>

<!-- The sidebar's (and drawer's) "Install app", until installed or "Not now". -->
{#if install.mode && !install.dismissed}
	<div class="flex items-center gap-1 border-t border-border px-2 py-1.5 {rail ? 'justify-center' : ''}" data-testid="install-entry">
		<button
			class="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground touch:h-11 touch:text-[0.9375rem] {rail ? 'flex-none justify-center' : ''}"
			title="Install octo·modern as an app"
			onclick={startInstall}
			data-testid="install-button"
		>
			<Download class="size-4 shrink-0 text-primary" />
			{#if !rail}<span class="truncate">Install app</span>{/if}
		</button>
		{#if !rail}
			<button class="btn btn-ghost btn-icon btn-sm shrink-0" title="Not now" aria-label="Not now" onclick={dismissInstall} data-testid="install-dismiss"><X /></button>
		{/if}
	</div>
{/if}
