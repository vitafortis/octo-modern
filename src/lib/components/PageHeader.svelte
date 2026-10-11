<script lang="ts">
	import type { Snippet } from 'svelte';
	let { title, description, actions }: { title: string; description?: string; actions?: Snippet } = $props();
</script>

<div class="relative">
	<div class="glow-top pointer-events-none absolute inset-x-0 -top-10 h-64"></div>
	<header class="page-x relative flex flex-wrap items-end justify-between gap-x-4 gap-y-3 pt-5 pb-4 sm:pt-8 sm:pb-6">
		<div>
			<h1 class="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
			{#if description}<p class="mt-1 text-sm text-muted-foreground">{description}</p>{/if}
		</div>
		{#if actions}<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>{/if}
	</header>
</div>
