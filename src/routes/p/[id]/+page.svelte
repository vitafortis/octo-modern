<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { CirclePause, CirclePlay, CircleStop, OctagonX, Settings2, WifiOff } from '@lucide/svelte';
	import StateBadge from '#lib/components/printer/StateBadge.svelte';
	import ConnectionControls from '#lib/components/printer/ConnectionControls.svelte';
	import PowerButtons from '#lib/components/power/PowerButtons.svelte';
	import { TAB_COMPONENTS, TAB_ICONS } from '#lib/components/printer/tabs.ts';
	import { canonicalSearch, paletteEntries, resolveTab, tabSearch, tabsFor } from '#lib/printer-tabs.ts';
	import { hiddenTabs, SERVER_LABEL } from '#lib/printer-kind.ts';
	import { LivePrinter } from '#lib/client/live.svelte.ts';
	import { emergencyStop, jobCommand } from '#lib/client/actions.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { registerPrinter } from '#lib/client/palette.svelte.ts';
	import { editor, isAdmin, printers } from '#lib/client/state.svelte.ts';
	import { isConnected, jobActive, progressPercent } from '#lib/printer.ts';
	import { phone } from '#lib/client/viewport.svelte.ts';
	import BedClearBanner from '#lib/components/queue/BedClearBanner.svelte';
	import PreparingBanner from '#lib/components/printer/PreparingBanner.svelte';
	import { pollQueue } from '#lib/client/queue.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The store copy reflects edits made in the dialog without a reload.
	const printer = $derived(printers.list.find((p) => p.id === data.printer.id) ?? data.printer);
	const canControl = $derived(data.canControl);
	const klipper = $derived(printer.kind === 'moonraker');

	// One live connection per printer page; a new one when navigating to another printer.
	const live = $derived(new LivePrinter(data.printer.id, data.snapshot ?? undefined));
	$effect(() => live.connect());
	// The queue's "bed is clear" prompt for this printer.
	$effect(() => pollQueue());

	// Views whose plugin is missing, and OctoPrint-only views on Klipper printers (timelapse, bed mesh), stay hidden.
	const TABS = $derived(tabsFor(data.features, hiddenTabs(printer)));
	const resolved = $derived(resolveTab(TABS, page.url.searchParams.get('tab'), page.url.searchParams.get('view')));
	const tab = $derived(resolved.tab);
	const view = $derived(resolved.view);
	const views = $derived(tab.views ?? []);

	function go(id: string, v: string | null = null, params: Record<string, string | null> = {}) {
		const keep: Record<string, string | null> = {};
		// Extra params (preview's file and v) belong to the view they were opened with.
		if (id === tab.id) for (const [k, val] of page.url.searchParams) if (k !== 'tab' && k !== 'view') keep[k] = val;
		Object.assign(keep, params);
		goto(`${page.url.pathname}${tabSearch(TABS, id, v, keep)}`, { replace: true, reset: false });
	}
	const openTab = (id: string) => go(id);
	const openView = (v: string | null, params: Record<string, string | null> = {}) => go(tab.id, v, params);

	// Old links (?tab=preview, ?tab=terminal, ?tab=bed…, from bookmarks and notifications): rewrite to the new place.
	$effect(() => {
		const next = canonicalSearch(TABS, page.url.searchParams);
		if (next !== null) void goto(`${page.url.pathname}${next}${page.url.hash}`, { replace: true, reset: false });
	});

	$effect(() =>
		registerPrinter({
			printerId: data.printer.id,
			openTab: (id) => {
				const [t, v] = id.split('/');
				go(t, v ?? null);
			},
			tabs: paletteEntries(TABS).map((e) => ({ id: e.id, label: e.label, keywords: e.keywords }))
		})
	);

	const s = $derived(live.snapshot);
	const pct = $derived(progressPercent(s));
	const color = $derived(COLORS[printer.color] ?? COLORS.violet);
	const active = $derived(canControl && jobActive(s.state));
</script>

{#snippet jobButtons(big: boolean)}
	{#if s.state === 'paused'}
		<button class="btn btn-secondary {big ? 'flex-1' : 'btn-sm'}" onclick={() => jobCommand(printer.id, 'resume')}><CirclePlay />Resume</button>
	{:else}
		<button class="btn btn-secondary {big ? 'flex-1' : 'btn-sm'}" disabled={s.state !== 'printing'} onclick={() => jobCommand(printer.id, 'pause')}><CirclePause />Pause</button>
	{/if}
	<button class="btn btn-danger-outline {big ? 'flex-1' : 'btn-sm'}" onclick={() => jobCommand(printer.id, 'cancel', s.job?.file?.display)}><CircleStop />{big ? 'Cancel' : 'Cancel print'}</button>
{/snippet}

<svelte:head><title>{pct != null ? `${Math.round(pct)}% · ` : ''}{printer.name} · octo·modern</title></svelte:head>

<div class="flex h-full flex-col overflow-hidden">
	<header class="relative shrink-0 border-b border-border">
		<div class="glow-top pointer-events-none absolute inset-x-0 -top-10 h-48 opacity-70"></div>
		<div class="page-x relative flex flex-wrap items-center gap-x-4 gap-y-2 pt-3 pb-2 short:py-1 lg:gap-y-3 lg:pt-6 lg:pb-4">
			<span class="hidden size-2.5 rounded-full lg:block" style="background:{color}; box-shadow:0 0 10px {color}"></span>
			<div class="min-w-0 flex-1 lg:flex-none">
				<div class="flex items-center gap-2.5">
					<!-- Below lg the top bar already names the printer. -->
					<h1 class="hidden truncate text-2xl font-semibold tracking-tight lg:block">{printer.name}</h1>
					<StateBadge state={s.state} text={s.stateText} preparing={!!s.preparing} />
				</div>
				<p class="mt-0.5 truncate font-mono text-xs text-muted-foreground short:hidden">
					{printer.baseUrl.replace(/^https?:\/\//, '')}{#if s.version}{' · '}{klipper ? s.version : `OctoPrint ${s.version}`}{/if}
				</p>
			</div>
			<div class="ml-auto flex flex-wrap items-center justify-end gap-2">
				{#if !live.connected}
					<span class="badge badge-warning" title="The live connection to octo·modern dropped; reconnecting"><WifiOff />reconnecting</span>
				{/if}
				{#if active}
					<!-- On phones these live in the bar at the bottom, under the thumb. -->
					{#if !phone.current}{@render jobButtons(false)}{/if}
				{:else}
					<ConnectionControls {live} {canControl} kind={printer.kind} />
				{/if}
				{#if canControl}<PowerButtons printerId={printer.id} name={printer.name} compact={phone.current} />{/if}
				{#if canControl && isConnected(s.state) && !(active && phone.current)}
					<!-- Phones: outlined rather than a solid red block next to Connect/Disconnect; it asks first either way. -->
					<button class="btn btn-sm {phone.current ? 'btn-danger-outline' : 'btn-danger'}" title={klipper ? 'Emergency stop (printer.emergency_stop)' : 'Emergency stop (M112)'} onclick={() => emergencyStop(printer.id, printer.name, klipper)}><OctagonX />Stop</button>
				{/if}
				{#if isAdmin()}
					<button class="btn btn-ghost btn-icon btn-sm" title="Edit server" aria-label="Edit server" onclick={() => (editor.target = printer)}><Settings2 /></button>
				{/if}
			</div>
		</div>
		<!-- Six sections. Phones: one row of icon-over-label buttons, no sideways scrolling (a bottom
		     tab bar would fight Pause/Cancel and the terminal prompt for the bottom edge). -->
		<nav class="relative grid grid-cols-6 px-0.5 sm:flex sm:gap-1 sm:px-4 lg:px-6" aria-label="Printer sections">
			{#each TABS as t (t.id)}
				{@const Icon = TAB_ICONS[t.id]}
				<button
					class="relative flex h-13 min-w-0 flex-col items-center justify-center gap-0.5 rounded-t-lg px-0 text-[0.6875rem] font-medium tracking-tight sm:tracking-normal transition-colors short:h-11 sm:h-10 sm:shrink-0 sm:flex-row sm:gap-1.5 sm:px-3 sm:text-[0.8125rem] touch:sm:h-11 touch:sm:text-sm lg:h-9 {tab.id === t.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}"
					aria-current={tab.id === t.id ? 'page' : undefined}
					data-tab={t.id}
					onclick={() => openTab(t.id)}
				>
					<Icon class="size-4.5 shrink-0 sm:size-3.5" /><span class="max-w-full truncate">{t.label}</span>
					{#if t.id === 'care' && data.updates > 0}
						<!-- Updates for OctoPrint or its plugins (admins): Care › Plugins & updates. -->
						<span class="absolute top-2 right-[calc(50%-1rem)] size-1.5 rounded-full bg-primary shadow-[0_0_6px_var(--primary)] sm:static sm:size-1.5" title="{data.updates} update{data.updates === 1 ? '' : 's'} available" data-testid="care-updates-dot"></span>
					{/if}
					{#if tab.id === t.id}<span class="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"></span>{/if}
				</button>
			{/each}
		</nav>
	</header>

	{#if s.state === 'offline' && s.problem}
		<div class="mx-4 mt-4 flex items-start gap-2 sm:mx-6 lg:mx-8 rounded-xl border border-danger/30 bg-danger/5 p-3 text-[0.8125rem]">
			<WifiOff class="mt-0.5 size-4 shrink-0 text-danger" />
			<div>
				<p class="font-medium">Can’t reach {SERVER_LABEL[printer.kind]}: {s.problem.message}</p>
				{#if s.problem.hint}<p class="mt-0.5 text-xs text-muted-foreground">{s.problem.hint}</p>{/if}
			</div>
		</div>
	{/if}

	<!-- Pre-print steps (leveling, G-code) running before a print starts. -->
	<PreparingBanner class="mx-4 mt-3 sm:mx-6 lg:mx-8" printerId={printer.id} preparing={s.preparing} {canControl} />

	<!-- Print queue: waiting for someone to clear the bed (above the scrolling content, so it's in reach on phones). -->
	{#if !(tab.id === 'jobs' && view === 'queue')}
	<BedClearBanner class="mx-4 mt-3 sm:mx-6 lg:mx-8" printerId={printer.id} name={printer.name} state={s.state} {canControl} />
	{/if}

	<div class="page-x min-h-0 flex-1 overflow-y-auto overscroll-contain py-4 lg:py-5 {tab.id === 'control' && view === 'terminal' ? 'flex flex-col max-sm:py-2' : ''}">
		{#key `${data.printer.id}:${tab.id}`}
			{@const Section = TAB_COMPONENTS[tab.id]}
			<Section {printer} {live} {canControl} tab={tab.id} {view} {views} {openView} counts={{ plugins: data.updates }} />
		{/key}
	</div>

	{#if active && phone.current}
		<!-- Phones: the running job's controls, always in reach. Steps aside for the keyboard. -->
		<div class="relative shrink-0 border-t border-border bg-surface/95 backdrop-blur-md in-[[data-keyboard]]:hidden" data-testid="job-bar">
			<div class="absolute inset-x-0 -top-px h-0.5 bg-border"><div class="h-full bg-primary transition-[width] duration-700 {s.state === 'paused' ? 'bg-warning' : ''}" style="width:{pct ?? 0}%"></div></div>
			<div class="page-x flex items-center gap-2 pt-2.5 pb-safe">
				{@render jobButtons(true)}
				<!-- Set apart, and it still asks first. -->
				<button class="btn btn-icon btn-danger-outline ml-1" title="Emergency stop (M112)" aria-label="Emergency stop" onclick={() => emergencyStop(printer.id, printer.name, klipper)}><OctagonX class="size-5!" /></button>
			</div>
		</div>
	{/if}
</div>
