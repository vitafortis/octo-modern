<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { CirclePause, CirclePlay, CircleStop, OctagonX, Settings2, WifiOff } from '@lucide/svelte';
	import StateBadge from '#lib/components/printer/StateBadge.svelte';
	import ConnectionControls from '#lib/components/printer/ConnectionControls.svelte';
	import PowerButtons from '#lib/components/power/PowerButtons.svelte';
	import { TABS } from '#lib/components/printer/tabs.ts';
	import { LivePrinter } from '#lib/client/live.svelte.ts';
	import { emergencyStop, jobCommand } from '#lib/client/actions.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { registerPrinter } from '#lib/client/palette.svelte.ts';
	import { editor, isAdmin, printers } from '#lib/client/state.svelte.ts';
	import { isConnected, jobActive, progressPercent } from '#lib/printer.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The store copy reflects edits made in the dialog without a reload.
	const printer = $derived(printers.list.find((p) => p.id === data.printer.id) ?? data.printer);
	const canControl = $derived(data.canControl);

	// One live connection per printer page; a new one when navigating to another printer.
	const live = $derived(new LivePrinter(data.printer.id, data.snapshot ?? undefined));
	$effect(() => live.connect());

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
</script>

<svelte:head><title>{pct != null ? `${Math.round(pct)}% · ` : ''}{printer.name} · octo·modern</title></svelte:head>

<div class="flex h-full flex-col overflow-hidden">
	<header class="relative shrink-0 border-b border-border">
		<div class="glow-top pointer-events-none absolute inset-x-0 -top-10 h-48 opacity-70"></div>
		<div class="relative flex flex-wrap items-center gap-x-4 gap-y-3 px-8 pt-6 pb-4">
			<span class="size-2.5 rounded-full" style="background:{color}; box-shadow:0 0 10px {color}"></span>
			<div class="min-w-0">
				<div class="flex items-center gap-2.5">
					<h1 class="truncate text-2xl font-semibold tracking-tight">{printer.name}</h1>
					<StateBadge state={s.state} text={s.stateText} />
				</div>
				<p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">
					{printer.baseUrl.replace(/^https?:\/\//, '')}{#if s.version}{' · '}OctoPrint {s.version}{/if}
				</p>
			</div>
			<div class="ml-auto flex items-center gap-2">
				{#if !live.connected}
					<span class="badge badge-warning" title="The live connection to octo·modern dropped; reconnecting"><WifiOff />reconnecting</span>
				{/if}
				{#if canControl && jobActive(s.state)}
					{#if s.state === 'paused'}
						<button class="btn btn-secondary btn-sm" onclick={() => jobCommand(printer.id, 'resume')}><CirclePlay />Resume</button>
					{:else}
						<button class="btn btn-secondary btn-sm" disabled={s.state !== 'printing'} onclick={() => jobCommand(printer.id, 'pause')}><CirclePause />Pause</button>
					{/if}
					<button class="btn btn-secondary btn-sm border-danger/40 text-danger hover:border-danger hover:bg-danger/10 hover:text-danger" onclick={() => jobCommand(printer.id, 'cancel', s.job?.file?.display)}><CircleStop />Cancel print</button>
				{:else}
					<ConnectionControls {live} {canControl} />
				{/if}
				{#if canControl}<PowerButtons printerId={printer.id} name={printer.name} />{/if}
				{#if canControl && isConnected(s.state)}
					<button class="btn btn-danger btn-sm" title="Emergency stop (M112)" onclick={() => emergencyStop(printer.id, printer.name)}><OctagonX />Stop</button>
				{/if}
				{#if isAdmin()}
					<button class="btn btn-ghost btn-icon btn-sm" title="Edit server" onclick={() => (editor.target = printer)}><Settings2 /></button>
				{/if}
			</div>
		</div>
		<nav class="relative flex gap-1 overflow-x-auto px-6" aria-label="Printer sections">
			{#each TABS as t (t.id)}
				<button
					class="relative flex h-9 shrink-0 items-center gap-1.5 rounded-t-lg px-3 text-[13px] font-medium transition-colors {tab.id === t.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}"
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
		<div class="mx-8 mt-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-[13px]">
			<WifiOff class="mt-0.5 size-4 shrink-0 text-danger" />
			<div>
				<p class="font-medium">Can’t reach OctoPrint: {s.problem.message}</p>
				{#if s.problem.hint}<p class="mt-0.5 text-xs text-muted-foreground">{s.problem.hint}</p>{/if}
			</div>
		</div>
	{/if}

	<div class="min-h-0 flex-1 overflow-y-auto px-8 py-5">
		{#key `${data.printer.id}:${tab.id}`}
			<tab.component {printer} {live} {canControl} />
		{/key}
	</div>
</div>
