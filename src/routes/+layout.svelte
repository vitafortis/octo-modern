<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { LayoutDashboard, Settings, Plus, Moon, Sun, LogOut, PanelLeftClose, PanelLeftOpen, Users, Plug, ScrollText, Search, History } from '@lucide/svelte';
	import Logo from '#lib/components/Logo.svelte';
	import Toaster from '#lib/components/Toaster.svelte';
	import ConfirmHost from '#lib/components/ConfirmHost.svelte';
	import PrinterDialog from '#lib/components/PrinterDialog.svelte';
	import CommandPalette from '#lib/components/CommandPalette.svelte';
	import StateDot from '#lib/components/printer/StateDot.svelte';
	import { api } from '#lib/client/api.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { editor, isAdmin, pollStatuses, printers, session, setTheme, statuses, theme } from '#lib/client/state.svelte.ts';
	import { progressPercent, STATE_LABEL } from '#lib/printer.ts';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	// Seed the shared store from the server render; pages refresh it after mutations.
	$effect.pre(() => {
		printers.list = data.printers;
		printers.loaded = true;
		session.viewer = data.viewer;
	});

	$effect(() => {
		theme.value = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
	});

	let filter = $state('');
	let collapsed = $state(false);
	const bare = $derived(page.url.pathname === '/login' || page.url.pathname === '/setup');
	// One printer: the app is that printer; no overview, no list to pick from.
	const single = $derived(printers.list.length === 1);
	const filtered = $derived(printers.list.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase())));

	// Live state dots and progress for the sidebar.
	$effect(() => {
		if (bare || !data.viewer) return;
		return pollStatuses();
	});

	const nav = $derived([
		...(single ? [] : [{ href: '/', label: 'Overview', icon: LayoutDashboard }]),
		{ href: '/history', label: 'History', icon: History },
		...(isAdmin()
			? [
					{ href: '/users', label: 'Users', icon: Users },
					{ href: '/integrations', label: 'Integrations', icon: Plug },
					{ href: '/audit', label: 'Audit log', icon: ScrollText },
					{ href: '/settings', label: 'Settings', icon: Settings }
				]
			: [])
	]);

	async function logout() {
		await api.post('/api/auth/logout');
		goto('/login');
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
			e.preventDefault();
			collapsed = !collapsed;
		}
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>octo·modern</title>
</svelte:head>

<svelte:window {onkeydown} />

{#snippet printerLink(p: (typeof printers.list)[number])}
	{@const s = statuses[p.id]}
	{@const pct = s ? progressPercent(s) : null}
	{@const active = page.url.pathname.startsWith(`/p/${p.id}`)}
	<a
		href="/p/{p.id}"
		title="{p.name} — {s ? STATE_LABEL[s.state] : 'loading'}{pct != null ? ` ${Math.round(pct)}%` : ''}"
		class="relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors {active
			? 'bg-accent text-foreground shadow-surface'
			: 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}"
	>
		{#if active}<span class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full" style="background:{COLORS[p.color] ?? COLORS.violet}"></span>{/if}
		<StateDot state={s?.state} />
		{#if !collapsed}
			<span class="min-w-0 flex-1 truncate">{p.name}</span>
			{#if pct != null}
				<span class="font-mono text-[11px] text-primary tabular-nums">{Math.round(pct)}%</span>
			{/if}
		{/if}
	</a>
	{#if pct != null && !collapsed}
		<div class="mx-2.5 -mt-1 mb-1 h-0.5 overflow-hidden rounded-full bg-border"><div class="h-full rounded-full bg-primary transition-[width] duration-700" style="width:{pct}%"></div></div>
	{/if}
{/snippet}

{#if bare}
	{@render children()}
{:else}
	<div class="flex h-dvh overflow-hidden">
		<aside class="flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 {collapsed ? 'w-14' : 'w-64'}">
			<div class="flex h-14 items-center gap-2.5 px-3.5">
				<a href="/" class="flex items-center gap-2.5">
					<Logo size={26} />
					{#if !collapsed}
						<span class="text-[15px] font-semibold tracking-tight">octo<span class="text-primary">·</span>modern</span>
					{/if}
				</a>
			</div>

			{#if single}
				<!-- One printer: it is the app, shown first and without a list header. -->
				<div class="px-2 pt-1">{@render printerLink(printers.list[0])}</div>
			{/if}

			<nav class="space-y-0.5 px-2 pt-1">
				{#each nav as item (item.href)}
					{@const active = item.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(item.href)}
					<a
						href={item.href}
						title={item.label}
						class="relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors {active
							? 'bg-accent text-foreground shadow-surface'
							: 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}"
					>
						{#if active}<span class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary"></span>{/if}
						<item.icon class="size-4 shrink-0" />
						{#if !collapsed}{item.label}{/if}
					</a>
				{/each}
			</nav>

			{#if !single}
				<div class="mt-5 flex items-center justify-between px-4 pb-1.5">
					{#if !collapsed}
						<span class="text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">Printers</span>
					{/if}
					{#if isAdmin()}
						<button class="btn btn-ghost btn-icon btn-sm -mr-1.5" title="Add printer" onclick={() => (editor.target = 'new')}><Plus /></button>
					{/if}
				</div>

				{#if !collapsed && printers.list.length > 8}
					<div class="relative mx-2 mb-1.5">
						<Search class="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
						<input class="input h-7 pl-7 text-xs" placeholder="Filter…" bind:value={filter} />
					</div>
				{/if}
			{/if}

			<div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
				{#if !single}
					{#each filtered as p (p.id)}
						{@render printerLink(p)}
					{:else}
						{#if !collapsed && isAdmin()}
							<button
								class="w-full rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
								onclick={() => (editor.target = 'new')}
							>
								No printers yet.<br /><span class="text-primary">Add an OctoPrint server →</span>
							</button>
						{:else if !collapsed}
							<p class="px-3 py-4 text-center text-xs text-muted-foreground">No printers shared with you yet.</p>
						{/if}
					{/each}
				{:else if isAdmin() && !collapsed}
					<button class="mt-1 flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-xs text-muted-foreground/80 hover:bg-accent/60 hover:text-foreground" onclick={() => (editor.target = 'new')}>
						<Plus class="size-3.5" />Add another printer
					</button>
				{/if}
			</div>

			{#if data.viewer && data.auth === 'authenticated' && !collapsed}
				<a href="/account" title="My account" class="flex items-center gap-2.5 border-t border-border px-3 py-2.5 transition-colors hover:bg-accent/60">
					<span class="grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary uppercase">
						{(data.viewer.name ?? data.viewer.email).slice(0, 1)}
					</span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-[12px] font-medium">{data.viewer.name ?? data.viewer.email}</p>
						<p class="truncate text-[11px] text-muted-foreground capitalize">{data.viewer.role}</p>
					</div>
				</a>
			{/if}
			<div class="flex items-center gap-1 border-t border-border p-2 {collapsed ? 'flex-col' : ''}">
				<button class="btn btn-ghost btn-icon btn-sm" title="Toggle sidebar (⌘B)" onclick={() => (collapsed = !collapsed)}>
					{#if collapsed}<PanelLeftOpen />{:else}<PanelLeftClose />{/if}
				</button>
				<button class="btn btn-ghost btn-icon btn-sm" title="Toggle theme" onclick={() => setTheme(theme.value === 'dark' ? 'light' : 'dark')}>
					{#if theme.value === 'dark'}<Sun />{:else}<Moon />{/if}
				</button>
				{#if !collapsed}
					<span class="ml-1 truncate font-mono text-[11px] text-muted-foreground/70" title="octo·modern version">v{data.version}</span>
				{/if}
				{#if data.auth === 'authenticated'}
					<button class="btn btn-ghost btn-icon btn-sm {collapsed ? '' : 'ml-auto'}" title="Sign out" onclick={logout}><LogOut /></button>
				{/if}
			</div>
		</aside>

		<main class="relative min-w-0 flex-1 overflow-hidden">
			{@render children()}
		</main>
	</div>
	<PrinterDialog />
	<!-- ⌘K / Ctrl+K: search printers, pages and actions. -->
	<CommandPalette signedIn={!!data.viewer} ontogglesidebar={() => (collapsed = !collapsed)} />
{/if}

<Toaster />
<ConfirmHost />
