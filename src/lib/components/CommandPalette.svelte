<script lang="ts">
	import type { Component } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { LayoutDashboard, LogOut, Moon, PanelLeft, Plug, Plus, Printer, ScrollText, Search, Settings, Sun, UserRound, Users, AppWindow, LibraryBig, History } from '@lucide/svelte';
	import { fuzzyRank } from '#lib/fuzzy.ts';
	import { api } from '#lib/client/api.ts';
	import { editor, isAdmin, printers, setTheme, statuses, theme } from '#lib/client/state.svelte.ts';
	import { isPaletteShortcut, loadRecents, noteRecent, palette, recents } from '#lib/client/palette.svelte.ts';
	import { STATE_LABEL } from '#lib/printer.ts';
	import { compactShell } from '#lib/client/viewport.svelte.ts';

	let { ontogglesidebar, signedIn = true }: { ontogglesidebar: () => void; signedIn?: boolean } = $props();

	type Item = {
		key: string;
		group: 'Actions' | 'Printers' | 'Pages' | 'Tabs';
		title: string;
		subtitle?: string;
		icon: Component;
		keywords?: string;
		run: () => void | Promise<void>;
	};

	let dialog = $state<HTMLDialogElement>();
	let input = $state<HTMLInputElement>();
	let list = $state<HTMLElement>();
	let query = $state('');
	let active = $state(0);

	function show() {
		palette.open = true;
	}

	// Opened by the shortcut or from elsewhere (the search button in the phone top bar).
	$effect(() => {
		if (palette.open && dialog && !dialog.open) {
			loadRecents();
			query = '';
			active = 0;
			dialog.showModal();
			queueMicrotask(() => input?.focus());
		} else if (!palette.open && dialog?.open) dialog.close();
	});

	function onwindowkey(e: KeyboardEvent) {
		if (!signedIn || !isPaletteShortcut(e)) return;
		e.preventDefault();
		if (palette.open) palette.open = false;
		else show();
	}

	async function signOut() {
		await api.post('/api/auth/logout').catch(() => {});
		goto('/login');
	}

	const items = $derived.by((): Item[] => {
		const out: Item[] = [];
		const ctx = palette.printer;
		const current = ctx ? printers.list.find((p) => p.id === ctx.printerId) : undefined;
		if (ctx && current) {
			for (const t of ctx.tabs) out.push({ key: `tab:${t.id}`, group: 'Tabs', title: t.label, subtitle: current.name, icon: AppWindow, run: () => ctx.openTab(t.id) });
		}
		if (isAdmin()) out.push({ key: 'act:new-printer', group: 'Actions', title: 'Add printer', icon: Plus, keywords: 'new server octoprint', run: () => void (editor.target = 'new') });
		out.push(
			{ key: 'act:theme', group: 'Actions', title: theme.value === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', icon: theme.value === 'dark' ? Sun : Moon, keywords: 'toggle theme dark light', run: () => setTheme(theme.value === 'dark' ? 'light' : 'dark') },
			{ key: 'act:sidebar', group: 'Actions', title: compactShell.current ? 'Open the menu' : 'Toggle sidebar', subtitle: compactShell.current ? undefined : '⌘B', icon: PanelLeft, keywords: 'collapse expand sidebar drawer menu', run: ontogglesidebar },
			{ key: 'act:sign-out', group: 'Actions', title: 'Sign out', icon: LogOut, keywords: 'logout log out', run: signOut }
		);
		for (const p of printers.list) {
			const s = statuses[p.id];
			out.push({ key: `printer:${p.id}`, group: 'Printers', title: p.name, subtitle: s ? STATE_LABEL[s.state] : undefined, icon: Printer, keywords: p.baseUrl, run: () => goto(`/p/${p.id}`) });
		}
		const pages: [string, string, Component, boolean][] = [
			['/', 'Overview', LayoutDashboard, printers.list.length !== 1],
			['/library', 'Library', LibraryBig, true],
			['/library/sources', 'Library sources', LibraryBig, isAdmin()],
			['/history', 'History', History, true],
			['/users', 'Users', Users, isAdmin()],
			['/integrations', 'Integrations', Plug, isAdmin()],
			['/audit', 'Audit log', ScrollText, isAdmin()],
			['/settings', 'Settings', Settings, isAdmin()],
			['/account', 'My account', UserRound, true]
		];
		for (const [href, title, icon, ok] of pages) if (ok) out.push({ key: `page:${href}`, group: 'Pages', title, icon, run: () => goto(href) });
		return out;
	});

	type Row = { item: Item; indexes: number[]; recent?: boolean };
	const results = $derived.by((): Row[] => {
		const q = query.trim();
		const recentRank = new Map(recents.items.map((k, i) => [k, i]));
		if (!q) {
			const byKey = new Map(items.map((i) => [i.key, i]));
			const recent = recents.items
				.map((k) => byKey.get(k))
				.filter((i): i is Item => !!i)
				.slice(0, 5);
			const seen = new Set(recent.map((i) => i.key));
			return [...recent.map((item) => ({ item, indexes: [], recent: true })), ...items.filter((i) => !seen.has(i.key)).map((item) => ({ item, indexes: [] }))];
		}
		return fuzzyRank(q, items, (i) => [i.title, `${i.subtitle ?? ''} ${i.keywords ?? ''}`], (i) => {
			const r = recentRank.get(i.key);
			return r === undefined ? 0 : 120 - r * 3;
		})
			.slice(0, 50)
			.map(({ item, indexes }) => ({ item, indexes }));
	});

	const sections = $derived.by(() => {
		if (query.trim()) return [{ title: null as string | null, rows: results.map((r, i) => ({ ...r, index: i })) }];
		const out: { title: string | null; rows: (Row & { index: number })[] }[] = [];
		results.forEach((r, i) => {
			const title = r.recent ? 'Recent' : r.item.group;
			const last = out[out.length - 1];
			if (last && last.title === title) last.rows.push({ ...r, index: i });
			else out.push({ title, rows: [{ ...r, index: i }] });
		});
		return out;
	});

	$effect(() => {
		void query;
		active = 0;
	});

	$effect(() => {
		void active;
		list?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	});

	function choose(row: Row | undefined) {
		if (!row) return;
		palette.open = false;
		noteRecent(row.item.key);
		void row.item.run();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
			e.preventDefault();
			active = Math.min(active + 1, results.length - 1);
		} else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
			e.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			choose(results[active]);
		}
	}

	function highlight(text: string, indexes: number[]): { text: string; hit: boolean }[] {
		if (!indexes.length) return [{ text, hit: false }];
		const set = new Set(indexes);
		const out: { text: string; hit: boolean }[] = [];
		for (let i = 0; i < text.length; i++) {
			const hit = set.has(i);
			const last = out[out.length - 1];
			if (last && last.hit === hit) last.text += text[i];
			else out.push({ text: text[i], hit });
		}
		return out;
	}

	$effect(() => {
		void page.url.pathname;
		palette.open = false;
	});
</script>

<svelte:window onkeydown={onwindowkey} />

<dialog
	bind:this={dialog}
	onclose={() => (palette.open = false)}
	onclick={(e) => e.target === dialog && (palette.open = false)}
	aria-label="Command palette"
	class="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-surface-lg backdrop:bg-black/40 backdrop:backdrop-blur-[2px] open:animate-[pop_.12s_ease-out] max-sm:m-0 max-sm:h-(--app-h,100dvh) max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:open:flex max-sm:open:flex-col max-sm:pt-[env(safe-area-inset-top)]"
>
	{#if palette.open}
		<div class="flex items-center gap-2.5 border-b border-border px-4">
			<Search class="size-4 shrink-0 text-muted-foreground" />
			<input
				bind:this={input}
				bind:value={query}
				{onkeydown}
				class="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/70 touch:h-14 touch:text-base"
				placeholder="Search printers, pages and actions…"
				role="combobox"
				aria-expanded="true"
				aria-controls="palette-list"
				aria-activedescendant={results.length ? `palette-${active}` : undefined}
				autocomplete="off"
				spellcheck="false"
			/>
			<span class="kbd">esc</span>
			<button class="btn btn-ghost -mr-2 px-3 mouse:hidden" onclick={() => (palette.open = false)}>Cancel</button>
		</div>
		<div bind:this={list} id="palette-list" role="listbox" class="max-h-[min(26rem,60vh)] overflow-y-auto overscroll-contain p-1.5 max-sm:max-h-none max-sm:min-h-0 max-sm:flex-1 max-sm:pb-[max(0.375rem,env(safe-area-inset-bottom))]">
			{#each sections as s, si (si)}
				{#if s.title}<p class="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{s.title}</p>{/if}
				{#each s.rows as r (r.item.key)}
					{@const Icon = r.item.icon}
					<button
						id="palette-{r.index}"
						data-index={r.index}
						role="option"
						aria-selected={r.index === active}
						class="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left touch:min-h-12 {r.index === active ? 'bg-accent text-foreground' : 'text-foreground/90'}"
						onmousemove={() => (active = r.index)}
						onclick={() => choose(r)}
					>
						<Icon class="size-4 shrink-0 {r.index === active ? 'text-primary' : 'text-muted-foreground'}" />
						<span class="min-w-0 flex-1 truncate text-[13px]">
							{#each highlight(r.item.title, r.indexes) as part, pi (pi)}{#if part.hit}<mark class="bg-transparent font-semibold text-primary">{part.text}</mark>{:else}{part.text}{/if}{/each}
						</span>
						{#if r.item.subtitle}<span class="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground">{r.item.subtitle}</span>{/if}
						{#if query.trim()}<span class="w-20 shrink-0 text-right text-[10px] text-muted-foreground/70">{r.item.group}</span>{/if}
					</button>
				{/each}
			{:else}
				<p class="px-3 py-8 text-center text-xs text-muted-foreground">Nothing matches “{query}”.</p>
			{/each}
		</div>
		<div class="flex items-center gap-3 border-t border-border bg-surface px-3 py-2 text-[11px] text-muted-foreground touch:hidden">
			<span class="flex items-center gap-1"><span class="kbd">↑</span><span class="kbd">↓</span>navigate</span>
			<span class="flex items-center gap-1"><span class="kbd">↵</span>open</span>
		</div>
	{/if}
</dialog>
