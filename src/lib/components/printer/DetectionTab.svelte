<script lang="ts">
	import { onMount } from 'svelte';
	import { CircleAlert, CircleCheck, CirclePause, Eye, ImageOff, LoaderCircle, ScanEye, Settings, ThumbsUp, TriangleAlert } from '@lucide/svelte';
	import Switch from '../Switch.svelte';
	import ScoreChart from '../detect/ScoreChart.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { confirmAction, isAdmin, toast } from '#lib/client/state.svelte.ts';
	import { INTERVAL, SENSITIVITY, SKIP_MINUTES, type DetectStatus, type FailureAction, type PrinterDetectSettings } from '#lib/detect.ts';
	import type { TabProps } from './tabs.ts';

	let { printer, canControl }: TabProps = $props();

	let st = $state<DetectStatus | null>(null);
	let error = $state('');
	let saving = $state(false);
	let draft = $state<PrinterDetectSettings | null>(null);

	async function load() {
		try {
			st = await api.get<DetectStatus>(`/api/printers/${printer.id}/detect`);
			draft ??= { ...st.settings };
			error = '';
		} catch (err) {
			error = errorMessage(err);
		}
	}

	onMount(() => {
		void load();
		const t = setInterval(load, 3_000);
		return () => clearInterval(t);
	});

	async function save(patch: Partial<PrinterDetectSettings>) {
		saving = true;
		try {
			st = await api.put<DetectStatus>(`/api/printers/${printer.id}/detect`, patch);
			draft = { ...st.settings };
		} catch (err) {
			toast('error', 'Couldn’t save', errorMessage(err));
			if (st) draft = { ...st.settings };
		} finally {
			saving = false;
		}
	}

	async function falseAlarm() {
		const ok = await confirmAction({
			title: 'Mark as a false alarm?',
			body: 'Failure detection stops watching this printer until the current print ends: no more frames, warnings or pauses for this print.',
			confirmLabel: 'It’s fine, stop watching'
		});
		if (!ok) return;
		try {
			st = await api.post<DetectStatus>(`/api/printers/${printer.id}/detect/dismiss`);
			toast('success', 'Marked as a false alarm', 'Detection resumes with the next print.');
		} catch (err) {
			toast('error', 'Couldn’t dismiss', errorMessage(err));
		}
	}

	const ACTIONS: { value: FailureAction; label: string; hint: string }[] = [
		{ value: 'none', label: 'Do nothing', hint: 'Only the warning notification.' },
		{ value: 'notify', label: 'Notify', hint: 'Send a “failure detected” notification with the frame.' },
		{ value: 'pause', label: 'Pause the print', hint: 'Pause in OctoPrint (audited as octo·modern detector) and notify.' }
	];

	const PHASE: Record<DetectStatus['phase'], { label: string; cls: string }> = {
		off: { label: 'Off', cls: '' },
		unconfigured: { label: 'Not set up', cls: 'badge-warning' },
		idle: { label: 'Not printing', cls: '' },
		waiting: { label: 'Waiting for the first minutes', cls: 'badge-primary' },
		watching: { label: 'Watching', cls: 'badge-success' },
		paused: { label: 'Print paused', cls: 'badge-warning' },
		dismissed: { label: 'False alarm: off for this print', cls: '' }
	};
	const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
	const sensLabel = (v: number) => (v < 0.85 ? 'Less sensitive' : v > 1.15 ? 'More sensitive' : 'Balanced (Obico default)');
	const canDismiss = $derived(!!st && canControl && (st.phase === 'watching' || st.phase === 'paused' || st.phase === 'waiting'));
	const frameSrc = $derived(st?.last ? `/api/printers/${printer.id}/detect/frame?t=${st.last.at}` : null);
	const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
</script>

{#if !st}
	<div class="grid h-40 place-items-center">
		{#if error}<p class="text-[13px] text-danger">{error}</p>{:else}<LoaderCircle class="size-5 animate-spin text-muted-foreground" />{/if}
	</div>
{:else}
	<div class="space-y-4" data-testid="detection-panel" data-phase={st.phase} data-level={st.level}>
		<section class="card flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
			<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><ScanEye class="size-4" /></span>
			<div class="min-w-0 flex-1">
				<h2 class="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
					Failure detection
					<span class="badge {PHASE[st.phase].cls}">{PHASE[st.phase].label}</span>
				</h2>
				<p class="mt-0.5 text-xs text-muted-foreground">
					Webcam frames go to your self-hosted Obico ML model while this printer prints; a smoothed score warns early and can pause a failing print.
				</p>
			</div>
			<label class="flex min-h-11 items-center gap-2 text-[13px]">
				<span class="text-muted-foreground">Enabled</span>
				<Switch label="Enable failure detection" checked={st.settings.enabled} disabled={!canControl || saving} onchange={(v) => save({ enabled: v })} />
			</label>
		</section>

		{#if st.phase === 'unconfigured'}
			<div class="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-[13px]">
				<Settings class="mt-0.5 size-4 shrink-0 text-warning" />
				<p>
					The ML API isn’t set up yet.
					{#if isAdmin()}Add its address in <a class="font-medium text-primary hover:underline" href="/settings#failure-detection">Settings → Failure detection</a>.{:else}Ask an admin to set it up in Settings.{/if}
				</p>
			</div>
		{/if}

		{#if st.error}
			<div class="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-[13px]" data-testid="detection-error">
				<CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
				<p class="min-w-0 break-words">{st.error}</p>
			</div>
		{/if}

		<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
			<section class="card self-start overflow-hidden">
				<div class="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
					<h3 class="text-[13px] font-semibold">Last analysed frame</h3>
					{#if st.last}<span class="text-xs text-muted-foreground">{st.last.boxes.length} detection{st.last.boxes.length === 1 ? '' : 's'} · {time(st.last.at)}</span>{/if}
				</div>
				{#if frameSrc}
					<img src={frameSrc} alt="Latest webcam frame with detections outlined" class="block aspect-video w-full bg-muted object-contain" data-testid="detection-frame" />
				{:else}
					<div class="grid aspect-video place-items-center bg-muted/50 text-center text-[13px] text-muted-foreground">
						<div><ImageOff class="mx-auto mb-2 size-5" />No frame analysed yet{st.phase === 'watching' ? '; the first one is on its way' : ''}.</div>
					</div>
				{/if}
			</section>

			<div class="space-y-4">
				<section class="card p-4">
					<div class="flex items-start justify-between gap-3">
						<div>
							<h3 class="text-[13px] font-semibold">Failure score</h3>
							<p class="text-xs text-muted-foreground">{st.print ? st.print.file : 'No print yet'}{st.frames ? ` · ${st.frames} frames` : ''}</p>
						</div>
						<div class="text-right">
							<p class="font-mono text-2xl font-semibold tracking-tight" data-testid="detection-score">{pct(st.score)}</p>
							{#if st.score != null}
								{#if st.level === 'failure'}<span class="badge badge-danger"><TriangleAlert />failure</span>
								{:else if st.level === 'warning'}<span class="badge badge-warning"><TriangleAlert />warning</span>
								{:else}<span class="badge badge-success"><CircleCheck />looks fine</span>{/if}
							{/if}
						</div>
					</div>
					<div class="mt-3">
						{#if st.history.length}
							<ScoreChart points={st.history} />
						{:else}
							<p class="rounded-lg bg-muted/50 px-3 py-6 text-center text-xs text-muted-foreground">The score appears once frames are analysed.</p>
						{/if}
					</div>
					{#if st.nextFrameAt && st.phase === 'waiting'}
						<p class="mt-2 text-xs text-muted-foreground">First frame around {time(st.nextFrameAt)} (skipping the first {st.settings.skipMinutes} min).</p>
					{/if}
					{#if canDismiss}
						<button class="btn {st.level === 'ok' ? 'btn-secondary' : 'btn-primary'} mt-3 h-11 w-full sm:h-9" onclick={falseAlarm} data-testid="false-alarm"><ThumbsUp />This is a false alarm</button>
					{/if}
					{#if st.dismissed}
						<p class="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Eye class="size-3.5" />Marked as a false alarm by {st.dismissed.by} {ago(new Date(st.dismissed.at).toISOString())}.</p>
					{/if}
				</section>

				{#if draft}
					<section class="card space-y-4 p-4">
						<h3 class="text-[13px] font-semibold">Settings</h3>
						<label class="block">
							<span class="label flex justify-between"><span>Sensitivity</span><span class="font-mono">{draft.sensitivity.toFixed(1)}</span></span>
							<input
								type="range"
								class="h-11 w-full accent-[var(--primary)] sm:h-7"
								min={SENSITIVITY.min}
								max={SENSITIVITY.max}
								step="0.1"
								disabled={!canControl}
								bind:value={draft.sensitivity}
								onchange={() => save({ sensitivity: Number(draft!.sensitivity) })}
							/>
							<span class="text-xs text-muted-foreground">{sensLabel(draft.sensitivity)}</span>
						</label>
						<label class="block">
							<span class="label">When a failure is detected</span>
							<select class="input h-11 w-full sm:h-9" disabled={!canControl} bind:value={draft.onFailure} onchange={() => save({ onFailure: draft!.onFailure })}>
								{#each ACTIONS as a (a.value)}<option value={a.value}>{a.label}</option>{/each}
							</select>
							<span class="mt-1 block text-xs text-muted-foreground">{ACTIONS.find((a) => a.value === draft!.onFailure)?.hint} Warnings always notify.</span>
						</label>
						<div class="grid grid-cols-2 gap-3">
							<label>
								<span class="label">Frame every (s)</span>
								<input class="input h-11 w-full sm:h-9" type="number" min={INTERVAL.min} max={INTERVAL.max} disabled={!canControl} bind:value={draft.intervalS} onchange={() => save({ intervalS: Number(draft!.intervalS) })} />
							</label>
							<label>
								<span class="label">Skip first (min)</span>
								<input class="input h-11 w-full sm:h-9" type="number" min={SKIP_MINUTES.min} max={SKIP_MINUTES.max} disabled={!canControl} bind:value={draft.skipMinutes} onchange={() => save({ skipMinutes: Number(draft!.skipMinutes) })} />
							</label>
						</div>
						{#if !canControl}<p class="text-xs text-muted-foreground">Operators and admins can change these.</p>{/if}
					</section>
				{/if}
			</div>
		</div>

		{#if st.events.length}
			<section class="card p-4">
				<h3 class="text-[13px] font-semibold">This print</h3>
				<ul class="mt-2 divide-y divide-border text-[13px]">
					{#each st.events as e (e.at + e.kind + e.detail)}
						<li class="flex items-start gap-2 py-2">
							{#if e.kind === 'paused'}<CirclePause class="mt-0.5 size-4 shrink-0 text-danger" />
							{:else if e.kind === 'failure'}<TriangleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
							{:else if e.kind === 'warning'}<TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" />
							{:else if e.kind === 'error'}<CircleAlert class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
							{:else}<ThumbsUp class="mt-0.5 size-4 shrink-0 text-muted-foreground" />{/if}
							<span class="min-w-0 flex-1 break-words">{e.detail}</span>
							<span class="shrink-0 text-xs text-muted-foreground">{time(e.at)}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
{/if}
