<script lang="ts">
	import { CirclePause, CirclePlay, CircleStop, Clock, FileBox, Hourglass, Layers, RotateCcw, Ruler, Timer } from '@lucide/svelte';
	import { jobCommand } from '#lib/client/actions.ts';
	import { bytes } from '#lib/client/format.ts';
	import type { LivePrinter } from '#lib/client/live.svelte.ts';
	import { filamentMeters, formatDuration, formatEta, jobActive, progressPercent } from '#lib/printer.ts';

	let { live, canControl }: { live: LivePrinter; canControl: boolean } = $props();

	const s = $derived(live.snapshot);
	const file = $derived(s.job?.file ?? null);
	const active = $derived(jobActive(s.state) || s.state === 'cancelling');
	const pct = $derived(progressPercent(s));
	const meters = $derived(filamentMeters(s.job));
	let busy = $state(false);

	// Tick once a second so "ETA" stays current between updates.
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	async function run(cmd: Parameters<typeof jobCommand>[1]) {
		busy = true;
		await jobCommand(live.id, cmd, file?.display);
		busy = false;
	}

	const ORIGIN: Record<string, string> = { local: 'OctoPrint', sdcard: 'SD card' };
</script>

<section class="card overflow-hidden">
	<div class="flex items-center gap-2 border-b border-border px-4 py-3">
		<h2 class="flex items-center gap-2 text-[14px] font-semibold"><FileBox class="size-4 text-primary" />Job</h2>
		{#if s.progress?.printTimeLeftOrigin && active}
			<span class="badge ml-auto" title="Where OctoPrint's time estimate comes from">estimate: {s.progress.printTimeLeftOrigin.replace(/-/g, ' ')}</span>
		{/if}
	</div>
	<div class="p-4">
		{#if file}
			<p class="truncate text-[15px] font-semibold tracking-tight" title={file.path}>{file.display}</p>
			<p class="mt-0.5 text-[11px] text-muted-foreground">{ORIGIN[file.origin] ?? file.origin}{file.size != null ? ` · ${bytes(file.size)}` : ''}{s.job?.user ? ` · started by ${s.job.user}` : ''}</p>
		{:else}
			<p class="text-[13px] text-muted-foreground">No file selected. Choose one in the Files tab{canControl ? '' : ' (operators)'}.</p>
		{/if}

		<div class="mt-4">
			<div class="flex items-baseline justify-between">
				<span class="text-3xl font-semibold tracking-tight tabular-nums">{pct != null ? `${pct.toFixed(1)}%` : active ? '…' : '—'}</span>
				{#if s.currentZ != null && active}<span class="font-mono text-xs text-muted-foreground">Z {s.currentZ.toFixed(2)} mm</span>{/if}
			</div>
			<div class="mt-2 h-2 overflow-hidden rounded-full bg-muted">
				<div class="h-full rounded-full transition-[width] duration-700 {s.state === 'paused' ? 'bg-warning' : 'bg-primary'}" style="width:{pct ?? 0}%"></div>
			</div>
		</div>

		<dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px] sm:grid-cols-4">
			<div>
				<dt class="flex items-center gap-1 text-[11px] text-muted-foreground"><Timer class="size-3" />Elapsed</dt>
				<dd class="mt-0.5 font-mono tabular-nums">{active ? formatDuration(s.progress?.printTime) : '—'}</dd>
			</div>
			<div>
				<dt class="flex items-center gap-1 text-[11px] text-muted-foreground"><Hourglass class="size-3" />Left</dt>
				<dd class="mt-0.5 font-mono tabular-nums">{active ? formatDuration(s.progress?.printTimeLeft) : formatDuration(s.job?.estimatedPrintTime)}</dd>
			</div>
			<div>
				<dt class="flex items-center gap-1 text-[11px] text-muted-foreground"><Clock class="size-3" />ETA</dt>
				<dd class="mt-0.5 font-mono tabular-nums">{active ? formatEta(s.progress?.printTimeLeft, now) : '—'}</dd>
			</div>
			<div>
				<dt class="flex items-center gap-1 text-[11px] text-muted-foreground"><Ruler class="size-3" />Filament</dt>
				<dd class="mt-0.5 font-mono tabular-nums">{meters != null ? `${meters.toFixed(2)} m` : '—'}</dd>
			</div>
		</dl>
	</div>

	{#if canControl}
		<div class="flex flex-wrap items-center gap-2 border-t border-border bg-surface px-4 py-2.5">
			{#if s.state === 'operational' && file}
				<button class="btn btn-primary btn-sm" disabled={busy} onclick={() => run('start')}><CirclePlay />Print</button>
			{/if}
			{#if s.state === 'printing' || s.state === 'resuming'}
				<button class="btn btn-secondary btn-sm" disabled={busy} onclick={() => run('pause')}><CirclePause />Pause</button>
			{/if}
			{#if s.state === 'paused' || s.state === 'pausing'}
				<button class="btn btn-primary btn-sm" disabled={busy || s.state === 'pausing'} onclick={() => run('resume')}><CirclePlay />Resume</button>
			{/if}
			{#if s.state === 'paused'}
				<button class="btn btn-ghost btn-sm" disabled={busy} onclick={() => run('restart')}><RotateCcw />Restart</button>
			{/if}
			{#if active && s.state !== 'cancelling'}
				<button class="btn btn-secondary btn-sm ml-auto border-danger/40 text-danger hover:border-danger hover:bg-danger/10 hover:text-danger" disabled={busy} onclick={() => run('cancel')}><CircleStop />Cancel print</button>
			{/if}
			{#if !active && !(s.state === 'operational' && file)}
				<span class="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Layers class="size-3.5" />{s.state === 'operational' ? 'Ready for a job.' : 'Connect the printer to print.'}</span>
			{/if}
		</div>
	{/if}
</section>
