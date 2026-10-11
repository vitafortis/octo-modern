<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { CirclePause, CirclePlay, CircleStop, OctagonX, Settings2, WifiOff } from '@lucide/svelte';
	import StateBadge from '#lib/components/printer/StateBadge.svelte';
	import ConnectionControls from '#lib/components/printer/ConnectionControls.svelte';
	import PowerButtons from '#lib/components/power/PowerButtons.svelte';
	import { tabsFor } from '#lib/components/printer/tabs.ts';
	import { LivePrinter } from '#lib/client/live.svelte.ts';
	import { emergencyStop, jobCommand } from '#lib/client/actions.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { registerPrinter } from '#lib/client/palette.svelte.ts';
	import { editor, isAdmin, printers } from '#lib/client/state.svelte.ts';
	import { isConnected, jobActive, progressPercent } from '#lib/printer.ts';
	import { phone } from '#lib/client/viewport.svelte.ts';
	import BedClearBanner from '#lib/components/queue/BedClearBanner.svelte';
	import { pollQueue } from '#lib/client/queue.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The store copy reflects edits made in the dialog without a reload.
	const printer = $derived(printers.list.find((p) => p.id === data.printer.id) ?? data.printer);
	const canControl = $derived(data.canControl);

	// One live connection per printer page; a new one when navigating to another printer.
	const live = $derived(new LivePrinter(data.printer.id, data.snapshot ?? undefined));
	$effect(() => live.connect());
	// The queue's "bed is clear" prompt for this printer.
	$effect(() => pollQueue());

	const TABS = $derived(tabsFor(data.features));
	const tab = $derived(TABS.find((t) => t.id === page.url.searchParams.get('tab')) ?? TABS[0]);
	function openTab(id: string) {
		const url = new URL(page.url.href);
		if (id === TABS[0].id) url.searchParams.delete('tab');
		else url.searchParams.set('tab', id);
		goto(url, { replace: true, reset: false });
	}

	$effect(() => registerPrinter({ printerId: data.printer.id, openTab, tabs: TABS.map((t) => ({ id: t.id, label: t.label })) }));

	const s = $derived(live.snapshot);
	const pct = $derived(progressPercent(s));
	const color = $derived(COLORS[printer.color] ?? COLORS.violet);
	const active = $derived(canControl && jobActive(s.state));

	// Keep the open tab in view in the (horizontally scrolling) tab strip on phones.
	let strip = $state<HTMLElement>();
	$effect(() => {
		void tab.id;
		strip?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
	});
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
					<StateBadge state={s.state} text={s.stateText} />
				</div>
				<p class="mt-0.5 truncate font-mono text-xs text-muted-foreground short:hidden">
					{printer.baseUrl.replace(/^https?:\/\//, '')}{#if s.version}{' · '}OctoPrint {s.version}{/if}
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
					<ConnectionControls {live} {canControl} />
				{/if}
				{#if canControl}<PowerButtons printerId={printer.id} name={printer.name} compact={phone.current} />{/if}
				{#if canControl && isConnected(s.state) && !(active && phone.current)}
					<!-- Phones: outlined rather than a solid red block next to Connect/Disconnect; it asks first either way. -->
					<button class="btn btn-sm {phone.current ? 'btn-danger-outline' : 'btn-danger'}" title="Emergency stop (M112)" onclick={() => emergencyStop(printer.id, printer.name)}><OctagonX />Stop</button>
				{/if}
				{#if isAdmin()}
					<button class="btn btn-ghost btn-icon btn-sm" title="Edit server" aria-label="Edit server" onclick={() => (editor.target = printer)}><Settings2 /></button>
				{/if}
			</div>
		</div>
		<!-- Seven sections: a strip that scrolls sideways on phones (a bottom tab bar would need a "More"
		     menu, and the bottom edge belongs to Pause/Cancel and the terminal prompt). -->
		<nav bind:this={strip} class="scrollbar-none relative flex snap-x gap-1 overflow-x-auto px-2 sm:px-4 lg:px-6" aria-label="Printer sections">
			{#each TABS as t (t.id)}
				<button
					class="relative flex h-10 shrink-0 snap-start items-center gap-1.5 rounded-t-lg px-3 text-[0.8125rem] font-medium transition-colors touch:h-11 touch:text-sm short:h-9 lg:h-9 {tab.id === t.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}"
					aria-current={tab.id === t.id ? 'page' : undefined}
					onclick={() => openTab(t.id)}
				>
					<t.icon class="size-3.5" />{t.label}
					{#if tab.id === t.id}<span class="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"></span>{/if}
				</button>
			{/each}
		</nav>
	</header>

	{#if s.state === 'offline' && s.problem}
		<div class="mx-4 mt-4 flex items-start gap-2 sm:mx-6 lg:mx-8 rounded-xl border border-danger/30 bg-danger/5 p-3 text-[0.8125rem]">
			<WifiOff class="mt-0.5 size-4 shrink-0 text-danger" />
			<div>
				<p class="font-medium">Can’t reach OctoPrint: {s.problem.message}</p>
				{#if s.problem.hint}<p class="mt-0.5 text-xs text-muted-foreground">{s.problem.hint}</p>{/if}
			</div>
		</div>
	{/if}

	<!-- Print queue: waiting for someone to clear the bed (above the scrolling content, so it's in reach on phones). -->
	{#if tab.id !== 'queue'}
	<BedClearBanner class="mx-4 mt-3 sm:mx-6 lg:mx-8" printerId={printer.id} name={printer.name} state={s.state} {canControl} />
	{/if}

	<div class="page-x min-h-0 flex-1 overflow-y-auto overscroll-contain py-4 lg:py-5 {tab.id === 'terminal' ? 'flex flex-col max-sm:py-2' : ''}">
		{#key `${data.printer.id}:${tab.id}`}
			<tab.component {printer} {live} {canControl} />
		{/key}
	</div>

	{#if active && phone.current}
		<!-- Phones: the running job's controls, always in reach. Steps aside for the keyboard. -->
		<div class="relative shrink-0 border-t border-border bg-surface/95 backdrop-blur-md in-[[data-keyboard]]:hidden" data-testid="job-bar">
			<div class="absolute inset-x-0 -top-px h-0.5 bg-border"><div class="h-full bg-primary transition-[width] duration-700 {s.state === 'paused' ? 'bg-warning' : ''}" style="width:{pct ?? 0}%"></div></div>
			<div class="page-x flex items-center gap-2 pt-2.5 pb-safe">
				{@render jobButtons(true)}
				<!-- Set apart, and it still asks first. -->
				<button class="btn btn-icon btn-danger-outline ml-1" title="Emergency stop (M112)" aria-label="Emergency stop" onclick={() => emergencyStop(printer.id, printer.name)}><OctagonX class="size-5!" /></button>
			</div>
		</div>
	{/if}
</div>
