<script lang="ts">
	import { page } from '$app/state';
	import { ArrowUpRight } from '@lucide/svelte';
	import { NAV_ICONS } from '#lib/client/nav-icons.ts';
	import { settingsSections } from '#lib/nav.ts';
	import type { LayoutProps } from './$types';

	/**
	 * The Settings area: General, Printers & Discover, Users, Notifications, Integrations and
	 * the audit log share this sub-navigation (a rail beside the page from md, a strip that
	 * scrolls sideways above it on phones). The pages keep their own paths.
	 */
	let { children, data }: LayoutProps = $props();

	const sections = $derived(settingsSections({ spoolman: data.spoolman, maintenanceTasks: data.maintenanceTasks }));
	const pages = $derived(sections.filter((s) => !s.setup));
	const setup = $derived(sections.filter((s) => s.setup));

	// Phones: keep the open section in view in the strip.
	let strip = $state<HTMLElement>();
	$effect(() => {
		void page.url.pathname;
		strip?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
	});
</script>

<div class="flex h-full flex-col md:flex-row">
	<!-- md and up: a rail beside the page. -->
	<nav class="hidden w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border px-2 pt-6 pb-4 md:flex" aria-label="Settings">
		<p class="px-2.5 pb-2 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Settings</p>
		{#each pages as s (s.href)}
			{@const Icon = NAV_ICONS[s.icon]}
			{@const on = s.match(page.url.pathname)}
			<a
				href={s.href}
				aria-current={on ? 'page' : undefined}
				class="relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] transition-colors touch:min-h-11 {on ? 'bg-accent text-foreground shadow-surface' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}"
			>
				{#if on}<span class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary"></span>{/if}
				<Icon class="size-4 shrink-0" />
				<span class="min-w-0">
					<span class="block truncate font-medium">{s.label}</span>
					<span class="block truncate text-[0.6875rem] text-muted-foreground">{s.description}</span>
				</span>
			</a>
		{/each}
		{#if setup.length}
			<p class="mt-4 px-2.5 pb-2 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Set up</p>
			{#each setup as s (s.href)}
				{@const Icon = NAV_ICONS[s.icon]}
				<a href={s.href} class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground touch:min-h-11" title="Opens the {s.label} page; it joins the sidebar once in use">
					<Icon class="size-4 shrink-0" />
					<span class="min-w-0 flex-1">
						<span class="block truncate font-medium">{s.label}</span>
						<span class="block truncate text-[0.6875rem]">{s.description}</span>
					</span>
					<ArrowUpRight class="size-3.5 shrink-0 opacity-60" />
				</a>
			{/each}
		{/if}
	</nav>

	<!-- Phones: a strip of sections above the page. -->
	<nav bind:this={strip} class="scrollbar-none flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2 md:hidden" aria-label="Settings sections" data-testid="settings-strip">
		{#each [...pages, ...setup] as s, i (s.href)}
			{@const Icon = NAV_ICONS[s.icon]}
			{@const on = s.match(page.url.pathname)}
			{#if s.setup && !sections[i - 1]?.setup}<span class="my-2 w-px shrink-0 bg-border"></span>{/if}
			<a
				href={s.href}
				aria-current={on ? 'page' : undefined}
				class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[0.8125rem] font-medium whitespace-nowrap transition-colors touch:h-11 {on ? 'bg-accent text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
			>
				<Icon class="size-4 shrink-0" />{s.label}
			</a>
		{/each}
	</nav>

	<div class="min-h-0 min-w-0 flex-1">
		{@render children()}
	</div>
</div>
