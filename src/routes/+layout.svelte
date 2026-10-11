<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { afterNavigate, goto } from '$app/navigation';
	import { LayoutDashboard, Settings, Plus, Moon, Sun, LogOut, LogIn, PanelLeftClose, PanelLeftOpen, Users, Plug, ScrollText, Search, Radar, LibraryBig, History, Menu, X, ListOrdered, Disc3, Wrench, BellRing } from '@lucide/svelte';
	import Logo from '#lib/components/Logo.svelte';
	import Toaster from '#lib/components/Toaster.svelte';
	import ConfirmHost from '#lib/components/ConfirmHost.svelte';
	import PrinterDialog from '#lib/components/PrinterDialog.svelte';
	import CommandPalette from '#lib/components/CommandPalette.svelte';
	import StateDot from '#lib/components/printer/StateDot.svelte';
	import PowerGlyph from '#lib/components/power/PowerGlyph.svelte';
	import PowerMenu, { powerMenu } from '#lib/components/power/PowerMenu.svelte';
	import { plugs } from '#lib/client/power.svelte.ts';
	import { api } from '#lib/client/api.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { editor, isAdmin, pollStatuses, printers, session, setTheme, statuses, theme } from '#lib/client/state.svelte.ts';
	import { progressPercent, STATE_LABEL } from '#lib/printer.ts';
	import { palette } from '#lib/client/palette.svelte.ts';
	import { compactShell, trackVisualViewport } from '#lib/client/viewport.svelte.ts';
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
		{ href: '/queue', label: 'Queue', icon: ListOrdered },
		{ href: '/library', label: 'Library', icon: LibraryBig },
		{ href: '/history', label: 'History', icon: History },
		{ href: '/filament', label: 'Filament', icon: Disc3 },
		{ href: '/maintenance', label: 'Maintenance', icon: Wrench, badge: data.maintenanceOverdue },
		...(isAdmin()
			? [
					{ href: '/discover', label: 'Discover', icon: Radar },
					{ href: '/users', label: 'Users', icon: Users },
					{ href: '/integrations', label: 'Integrations', icon: Plug },
					{ href: '/notifications', label: 'Notifications', icon: BellRing },
					{ href: '/audit', label: 'Audit log', icon: ScrollText },
					{ href: '/settings', label: 'Settings', icon: Settings }
				]
			: [])
	]);

	async function logout() {
		await api.post('/api/auth/logout');
		goto('/login');
	}

	function toggleSidebar() {
		if (compactShell.current) drawerOpen = !drawerOpen;
		else collapsed = !collapsed;
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
			e.preventDefault();
			toggleSidebar();
		}
	}

	// --- phones and tablets: a slim top bar, and the sidebar as an off-canvas drawer ----------
	let drawerOpen = $state(false);
	let drawer = $state<HTMLDialogElement>();
	$effect(() => {
		if (!drawer) return;
		if (drawerOpen && !drawer.open) drawer.showModal();
		else if (!drawerOpen && drawer.open) drawer.close();
	});
	// Growing past lg with the drawer open: the sidebar is back, the drawer goes.
	$effect(() => {
		if (!compactShell.current) drawerOpen = false;
	});
	afterNavigate(() => (drawerOpen = false));
	// Something opened on top (add printer, the palette): the drawer has done its job.
	$effect(() => {
		if (editor.target || palette.open) drawerOpen = false;
	});
	$effect(() => trackVisualViewport());

	/** Swipe the drawer away to the left. */
	let swipe: { x: number; y: number; dx: number } | null = null;
	let drawerPanel = $state<HTMLElement>();
	function swipeStart(e: TouchEvent) {
		swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0 };
	}
	function swipeMove(e: TouchEvent) {
		if (!swipe || !drawerPanel) return;
		const dx = e.touches[0].clientX - swipe.x;
		const dy = e.touches[0].clientY - swipe.y;
		if (Math.abs(dy) > Math.abs(dx) && swipe.dx === 0) return (swipe = null);
		swipe.dx = Math.min(0, dx);
		drawerPanel.style.transform = `translateX(${swipe.dx}px)`;
		drawerPanel.style.transition = 'none';
	}
	function swipeEnd() {
		if (!swipe || !drawerPanel) return;
		const far = swipe.dx < -70;
		drawerPanel.style.transition = '';
		drawerPanel.style.transform = '';
		swipe = null;
		if (far) drawerOpen = false;
	}

	/** What the top bar says: the page, or the printer and its state. */
	const current = $derived.by(() => {
		const path = page.url.pathname;
		const m = /^\/p\/([^/]+)/.exec(path);
		if (m) {
			const p = printers.list.find((x) => x.id === m[1]);
			const s = p ? statuses[p.id] : undefined;
			return { title: p?.name ?? 'Printer', state: s?.state, pct: s ? progressPercent(s) : null, color: p ? (COLORS[p.color] ?? COLORS.violet) : null };
		}
		const extra: [string, string][] = [['/library/sources', 'Library sources'], ['/account', 'My account']];
		const hit = extra.find(([h]) => path.startsWith(h)) ?? [...nav].reverse().map((n) => [n.href, n.label] as [string, string]).find(([h]) => (h === '/' ? path === '/' : path.startsWith(h)));
		return { title: hit?.[1] ?? 'octo·modern', state: undefined, pct: null, color: null };
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>octo·modern</title>
</svelte:head>

<svelte:window {onkeydown} />

{#snippet printerLink(p: (typeof printers.list)[number], rail: boolean)}
	{@const s = statuses[p.id]}
	{@const pct = s ? progressPercent(s) : null}
	{@const active = page.url.pathname.startsWith(`/p/${p.id}`)}
	<a
		href="/p/{p.id}"
		title="{p.name} — {s ? STATE_LABEL[s.state] : 'loading'}{pct != null ? ` ${Math.round(pct)}%` : ''}"
		oncontextmenu={(e) => {
			// Smart plug: power on/off from the sidebar.
			if (!plugs[p.id]) return;
			e.preventDefault();
			powerMenu.target = { id: p.id, name: p.name, control: !!p.access?.control };
			powerMenu.x = e.clientX;
			powerMenu.y = e.clientY;
		}}
		class="relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[0.8125rem] transition-colors touch:h-11 touch:text-[0.9375rem] {active
			? 'bg-accent text-foreground shadow-surface'
			: 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}"
	>
		{#if active}<span class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full" style="background:{COLORS[p.color] ?? COLORS.violet}"></span>{/if}
		<StateDot state={s?.state} />
		{#if !collapsed}
			<span class="min-w-0 flex-1 truncate">{p.name}</span>
			<PowerGlyph printerId={p.id} />
			{#if pct != null}
				<span class="font-mono text-[0.6875rem] text-primary tabular-nums">{Math.round(pct)}%</span>
			{/if}
		{/if}
	</a>
	{#if pct != null && !collapsed}
		<div class="mx-2.5 -mt-1 mb-1 h-0.5 overflow-hidden rounded-full bg-border"><div class="h-full rounded-full bg-primary transition-[width] duration-700" style="width:{pct}%"></div></div>
	{/if}
{/snippet}

{#snippet sidebar(rail: boolean, inDrawer: boolean)}
			<div class="flex h-14 items-center gap-2.5 px-3.5">
				<a href="/" class="flex items-center gap-2.5">
					<Logo size={26} />
					{#if !rail}
						<span class="text-[0.9375rem] font-semibold tracking-tight">octo<span class="text-primary">·</span>modern</span>
					{/if}
				</a>
			</div>

			{#if single}
				<!-- One printer: it is the app, shown first and without a list header. -->
				<div class="px-2 pt-1">{@render printerLink(printers.list[0], rail)}</div>
			{/if}

			<nav class="space-y-0.5 px-2 pt-1">
				{#each nav as item (item.href)}
					{@const active = item.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(item.href)}
					<a
						href={item.href}
						title={item.label}
						class="relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[0.8125rem] font-medium transition-colors touch:h-11 touch:text-[0.9375rem] {active
							? 'bg-accent text-foreground shadow-surface'
							: 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}"
					>
						{#if active}<span class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary"></span>{/if}
						<item.icon class="size-4 shrink-0" />
						{#if !rail}{item.label}{/if}
						{#if 'badge' in item && item.badge}
							<span
								class="{rail ? 'absolute top-1 right-1 size-2 p-0' : 'ml-auto h-4 min-w-4 px-1'} grid place-items-center rounded-full bg-danger text-[0.625rem] leading-none font-semibold text-white tabular-nums"
								title="{item.badge} overdue maintenance task{item.badge === 1 ? '' : 's'}"
								data-testid="maintenance-badge">{rail ? '' : item.badge}</span
							>
						{/if}
					</a>
				{/each}
			</nav>

			{#if !single}
				<div class="mt-5 flex items-center justify-between px-4 pb-1.5">
					{#if !rail}
						<span class="text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Printers</span>
					{/if}
					{#if isAdmin()}
						<button class="btn btn-ghost btn-icon btn-sm -mr-1.5" title="Add printer" onclick={() => (editor.target = 'new')}><Plus /></button>
					{/if}
				</div>

				{#if !rail && printers.list.length > 8}
					<div class="relative mx-2 mb-1.5">
						<Search class="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
						<input class="input h-7 pl-7 text-xs" placeholder="Filter…" bind:value={filter} />
					</div>
				{/if}
			{/if}

			<div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
				{#if !single}
					{#each filtered as p (p.id)}
						{@render printerLink(p, rail)}
					{:else}
						{#if !rail && isAdmin()}
							<button
								class="w-full rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
								onclick={() => (editor.target = 'new')}
							>
								No printers yet.<br /><span class="text-primary">Add an OctoPrint server →</span>
							</button>
						{:else if !rail}
							<p class="px-3 py-4 text-center text-xs text-muted-foreground">No printers shared with you yet.</p>
						{/if}
					{/each}
				{:else if isAdmin() && !rail}
					<button class="mt-1 flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-xs text-muted-foreground/80 hover:bg-accent/60 hover:text-foreground" onclick={() => (editor.target = 'new')}>
						<Plus class="size-3.5" />Add another printer
					</button>
				{/if}
			</div>

			{#if data.viewer && data.auth === 'authenticated' && !rail}
				<a href="/account" title="My account" class="flex items-center gap-2.5 border-t border-border px-3 py-2.5 transition-colors hover:bg-accent/60">
					<span class="grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-[0.6875rem] font-semibold text-primary uppercase">
						{(data.viewer.name ?? data.viewer.email).slice(0, 1)}
					</span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-xs font-medium">{data.viewer.name ?? data.viewer.email}</p>
						<p class="truncate text-[0.6875rem] text-muted-foreground capitalize">{data.viewer.role}</p>
					</div>
				</a>
			{/if}
			<div class="flex items-center gap-1 border-t border-border p-2 {rail ? 'flex-col' : ''}">
				{#if inDrawer}
					<button class="btn btn-ghost btn-icon btn-sm" title="Close menu" aria-label="Close menu" onclick={() => (drawerOpen = false)}><X /></button>
				{:else}
					<button class="btn btn-ghost btn-icon btn-sm" title="Toggle sidebar (⌘B)" onclick={() => (collapsed = !collapsed)}>
						{#if rail}<PanelLeftOpen />{:else}<PanelLeftClose />{/if}
					</button>
				{/if}
				<button class="btn btn-ghost btn-icon btn-sm" title="Toggle theme" onclick={() => setTheme(theme.value === 'dark' ? 'light' : 'dark')}>
					{#if theme.value === 'dark'}<Sun />{:else}<Moon />{/if}
				</button>
				{#if !rail}
					<span class="ml-1 truncate font-mono text-[0.6875rem] text-muted-foreground/70" title="octo·modern version">v{data.version}</span>
				{/if}
				{#if data.auth === 'authenticated'}
					<button class="btn btn-ghost btn-icon btn-sm {rail ? '' : 'ml-auto'}" title="Sign out" onclick={logout}><LogOut /></button>
				{:else if data.auth === 'open'}
					<a class="btn btn-ghost btn-icon btn-sm {rail ? '' : 'ml-auto'}" title="Sign in (browsing as a guest: {data.viewer?.role === 'operator' ? 'can control printers' : 'watch only'})" href="/login"><LogIn /></a>
				{/if}
			</div>
		{/snippet}

{#if bare}
	{@render children()}
{:else}
	<div class="flex h-(--app-h,100dvh) flex-col overflow-hidden lg:flex-row">
		<!-- Phones and tablets: a slim bar with the menu, where you are, and search. -->
		<header class="z-30 shrink-0 border-b border-border bg-surface/95 pt-safe backdrop-blur-md lg:hidden" style="padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)" data-testid="topbar">
			<div class="flex h-13 items-center gap-1 px-1.5 short:h-11">
				<button class="btn btn-ghost btn-icon relative" aria-label="Open menu" aria-expanded={drawerOpen} onclick={() => (drawerOpen = true)}
					><Menu class="size-5!" />{#if data.maintenanceOverdue}<span class="absolute top-2 right-2 size-2 rounded-full bg-danger" title="Maintenance overdue"></span>{/if}</button
				>
				<a href="/" class="shrink-0 p-1" aria-label="octo·modern home"><Logo size={24} /></a>
				<div class="flex min-w-0 flex-1 items-center gap-2 pl-1.5">
					{#if current.color}<StateDot state={current.state} />{/if}
					<span class="truncate text-[0.9375rem] font-semibold tracking-tight" data-testid="topbar-title">{current.title}</span>
					{#if current.pct != null}<span class="shrink-0 font-mono text-xs text-primary tabular-nums">{Math.round(current.pct)}%</span>{/if}
				</div>
				{#if data.viewer}
					<button class="btn btn-ghost btn-icon" aria-label="Search and commands" title="Search (⌘K)" onclick={() => (palette.open = true)}><Search class="size-5!" /></button>
				{/if}
			</div>
		</header>
		<aside class="hidden shrink-0 lg:flex flex-col border-r border-border bg-surface transition-[width] duration-200 {collapsed ? 'w-14' : 'w-64'}">
			{@render sidebar(collapsed, false)}
		</aside>

		<main class="relative min-w-0 flex-1 overflow-hidden">
			{@render children()}
		</main>
	</div>
	<PrinterDialog />
	<PowerMenu />
	<!-- ⌘K / Ctrl+K: search printers, pages and actions. -->
	<CommandPalette signedIn={!!data.viewer} ontogglesidebar={toggleSidebar} />
	<!-- The sidebar as a drawer below lg: a modal dialog, so focus stays inside and Esc closes it. -->
	<dialog
		bind:this={drawer}
		onclose={() => (drawerOpen = false)}
		onclick={(e) => e.target === drawer && (drawerOpen = false)}
		aria-label="Menu"
		class="m-0 h-(--app-h,100dvh) max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-black/50 backdrop:backdrop-blur-[2px] lg:hidden"
		data-testid="drawer"
	>
		{#if drawerOpen}
			<!-- svelte-ignore a11y_no_static_element_interactions, a11y_autofocus -->
			<div
				bind:this={drawerPanel}
				tabindex="-1"
				autofocus
				class="flex h-full outline-none w-[min(19rem,86vw)] flex-col border-r border-border bg-surface pt-safe pb-[env(safe-area-inset-bottom)] text-foreground shadow-surface-lg transition-transform duration-200 animate-[drawer-in_.2s_ease-out]"
				style="padding-left:env(safe-area-inset-left)"
				ontouchstart={swipeStart}
				ontouchmove={swipeMove}
				ontouchend={swipeEnd}
				ontouchcancel={swipeEnd}
			>
				{@render sidebar(false, true)}
			</div>
		{/if}
	</dialog>
{/if}

<Toaster />
<ConfirmHost />
