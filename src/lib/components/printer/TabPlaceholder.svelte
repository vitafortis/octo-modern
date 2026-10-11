<script lang="ts">
	import type { Component } from 'svelte';

	/** Stand-in for a tab that isn't built yet (phase 2). */
	let { icon: Icon, title, description }: { icon: Component; title: string; description: string } = $props();
</script>

<div class="card relative overflow-hidden px-6 py-14 text-center">
	<div class="dot-grid mask-fade pointer-events-none absolute inset-0"></div>
	<div class="relative mx-auto max-w-md">
		<div class="mx-auto grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><Icon class="size-5" /></div>
		<h2 class="mt-4 text-[0.9375rem] font-semibold tracking-tight">{title}</h2>
		<p class="mt-1.5 text-[0.8125rem] text-muted-foreground">{description}</p>
		<span class="badge mt-4">Coming soon</span>
	</div>
</div>
