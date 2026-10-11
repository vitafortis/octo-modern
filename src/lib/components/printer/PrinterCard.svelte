<script lang="ts">
	import { CircleAlert, CirclePause, CirclePlay, CircleStop, Clock, FileBox, Settings2, Unplug } from '@lucide/svelte';
	import StateBadge from './StateBadge.svelte';
	import WebcamThumb from './WebcamThumb.svelte';
	import PowerStrip from '../power/PowerStrip.svelte';
	import { COLORS } from '#lib/client/format.ts';
	import { editor, isAdmin } from '#lib/client/state.svelte.ts';
	import { jobCommand } from '#lib/client/actions.ts';
	import { formatDuration, formatEta, formatTemp, heaterKeys, heaterLabel, jobActive, progressPercent, type LiveSnapshot } from '#lib/printer.ts';
	import type { Printer } from '#lib/types.ts';

	let { printer, snapshot }: { printer: Printer; snapshot: LiveSnapshot | undefined } = $props();

	const color = $derived(COLORS[printer.color] ?? COLORS.violet);
	const s = $derived(snapshot);
	const active = $derived(s ? jobActive(s.state) : false);
	const pct = $derived(s ? progressPercent(s) : null);
	const heaters = $derived(s ? heaterKeys(s.temps) : []);
	const tools = $derived(heaters.filter((k) => k.startsWith('tool')).length);
</script>

<div class="card group relative flex flex-col overflow-hidden transition-shadow hover:shadow-surface-lg">
	<div class="pointer-events-none absolute -top-16 -right-16 size-40 rounded-full opacity-[0.12] blur-2xl" style="background:{color}"></div>
	<a href="/p/{printer.id}" class="relative flex flex-1 flex-col">
		{#if s && s.state !== 'offline'}<WebcamThumb printerId={printer.id} class="aspect-[16/7] w-full border-b border-border" />{/if}
		<div class="flex flex-1 flex-col p-4">
		<div class="flex items-start gap-3">
			<div class="min-w-0 flex-1">
				<h3 class="truncate text-[15px] font-semibold tracking-tight">{printer.name}</h3>
				<p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{printer.baseUrl.replace(/^https?:\/\//, '')}</p>
			</div>
			{#if s}<StateBadge state={s.state} text={s.stateText} />{:else}<span class="badge animate-pulse">Loading</span>{/if}
		</div>

		{#if s?.state === 'offline'}
			<div class="mt-4 flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 p-2.5 text-[11px]">
				<CircleAlert class="mt-px size-3.5 shrink-0 text-danger" />
				<div class="min-w-0"><p class="font-medium text-foreground">{s.problem?.message ?? 'Unreachable'}</p>{#if s.problem?.hint}<p class="mt-0.5 line-clamp-2 text-muted-foreground">{s.problem.hint}</p>{/if}</div>
			</div>
		{:else if s?.state === 'disconnected'}
			<p class="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><Unplug class="size-3.5" />OctoPrint is up; no printer connected.</p>
		{/if}

		{#if active && s}
			<div class="mt-4">
				<div class="min-w-0">
					<p class="flex items-start gap-1.5 text-[13px] font-medium" title={s.job?.file?.display}><FileBox class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><span class="min-w-0 line-clamp-2 [overflow-wrap:anywhere] sm:truncate">{s.job?.file?.display ?? 'Unknown file'}</span></p>
					<div class="mt-2 flex flex-wrap items-baseline justify-between gap-x-3">
						<span class="text-2xl font-semibold tracking-tight tabular-nums">{pct != null ? `${pct.toFixed(pct >= 10 ? 0 : 1)}%` : '—'}</span>
						{#if s.progress?.printTimeLeft != null}<span class="flex items-center gap-1 text-[11px] text-muted-foreground"><Clock class="size-3" />{formatDuration(s.progress.printTimeLeft)} left · {formatEta(s.progress.printTimeLeft)}</span>{/if}
					</div>
					<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-primary transition-[width] duration-700" style="width:{pct ?? 0}%"></div></div>
				</div>
			</div>
		{/if}

		{#if heaters.length}
			<div class="mt-auto grid grid-cols-2 gap-2 pt-4 sm:grid-cols-3">
				{#each heaters as k (k)}
					{@const t = s!.temps[k]}
					<div class="rounded-lg border border-border bg-surface px-2.5 py-1.5">
						<p class="text-[10px] font-medium text-muted-foreground uppercase">{heaterLabel(k, tools)}</p>
						<p class="font-mono text-[13px] tabular-nums">{formatTemp(t.actual)}<span class="text-muted-foreground"> / {t.target ? formatTemp(t.target) : 'off'}</span></p>
					</div>
				{/each}
			</div>
		{/if}
		</div>
	</a>
	{#if printer.access?.control && s && jobActive(s.state)}
		<div class="relative flex items-center gap-1.5 border-t border-border bg-surface px-4 py-2">
			{#if s.state === 'paused'}
				<button class="btn btn-secondary btn-sm" onclick={() => jobCommand(printer.id, 'resume')}><CirclePlay />Resume</button>
			{:else}
				<button class="btn btn-secondary btn-sm" disabled={s.state !== 'printing'} onclick={() => jobCommand(printer.id, 'pause')}><CirclePause />Pause</button>
			{/if}
			<button class="btn btn-secondary btn-sm ml-auto border-danger/40 text-danger hover:border-danger hover:bg-danger/10 hover:text-danger" onclick={() => jobCommand(printer.id, 'cancel', s.job?.file?.display)}><CircleStop />Cancel print</button>
		</div>
	{/if}
	<PowerStrip {printer} />
	{#if isAdmin()}
		<button class="btn btn-ghost btn-icon btn-sm absolute top-2 right-2 bg-card/80 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100" title="Edit {printer.name}" onclick={() => (editor.target = printer)}><Settings2 /></button>
	{/if}
</div>
