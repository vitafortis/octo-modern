<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ArrowDown,
		ArrowDownToLine,
		ArrowLeft,
		ArrowRight,
		ArrowUp,
		ArrowUpFromLine,
		Box,
		ChevronsDown,
		ChevronsUp,
		CircleAlert,
		Fan,
		Gauge,
		House,
		Keyboard,
		LoaderCircle,
		Lock,
		Move,
		PowerOff,
		SlidersHorizontal,
		Thermometer,
		X
	} from '@lucide/svelte';
	import CustomControls from './CustomControls.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { control, controlUrl, type ControlInfo } from '#lib/client/control.ts';
	import { fillTemplate, type CustomControl } from '#lib/control/custom.ts';
	import { EXTRUDE_LENGTHS, FEEDRATE, FLOWRATE, JOG_STEPS, MAX_EXTRUDE_MM, MIN_EXTRUDE_TEMP, jogVector, movementBlocked, stepFits, type Direction, type MoveAxis } from '#lib/control/jog.ts';
	import { DEFAULT_PROFILE } from '#lib/control/profile.ts';
	import { isConnected } from '#lib/printer.ts';
	import type { TabProps } from './tabs.ts';

	let { printer, live, canControl }: TabProps = $props();

	let info = $state<ControlInfo | null>(null);
	let loadError = $state('');
	let step = $state<number>(10);
	let inflight = $state(0);
	let padFocused = $state(false);
	let showKeys = $state(false);
	let extrudeLength = $state(5);
	let activeTool = $state(0);
	let feed = $state(100);
	let flow = $state(100);
	let fan = $state(100);

	const s = $derived(live.snapshot);
	const profile = $derived(info?.profile ?? DEFAULT_PROFILE);
	const connected = $derived(isConnected(s.state) && s.state !== 'error');
	const blocked = $derived(movementBlocked(s.state));
	const canMove = $derived(canControl && !blocked);
	const canTune = $derived(canControl && connected);
	const toolKey = $derived(`tool${activeTool}`);
	const hotend = $derived(s.temps[toolKey]?.actual ?? s.temps.tool0?.actual ?? null);
	const cold = $derived(hotend != null && hotend < MIN_EXTRUDE_TEMP);
	const inverted = $derived((['x', 'y', 'z'] as const).filter((a) => profile.axes[a].inverted));

	async function load() {
		loadError = '';
		try {
			info = await api.get<ControlInfo>(controlUrl(live.id));
			if (activeTool >= info.profile.extruders) activeTool = 0;
		} catch (err) {
			loadError = errorMessage(err);
		}
	}

	onMount(() => {
		void load();
		// The profile can change with the connection (OctoPrint connects with a chosen profile).
		const offs = [live.on('Connected', () => void load()), live.on('PrinterProfileModified', () => void load())];
		return () => offs.forEach((off) => off());
	});

	async function send(body: Record<string, unknown>, opts: { done?: string } = {}) {
		inflight++;
		try {
			return await control(live.id, body, opts);
		} finally {
			inflight--;
		}
	}

	function jog(dir: Partial<Record<MoveAxis, Direction>>) {
		if (!canMove) return;
		// Holding a key repeats; don't let requests pile up behind a slow printer.
		if (inflight > 2) return;
		const axes = Object.keys(dir) as MoveAxis[];
		if (!stepFits(step, profile, axes)) return;
		void send({ action: 'jog', ...jogVector(dir, step, profile) });
	}

	const home = (axes: MoveAxis[]) => canMove && send({ action: 'home', axes });

	function onPadKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
		const map: Record<string, () => void> = {
			ArrowLeft: () => jog({ x: -1 }),
			ArrowRight: () => jog({ x: 1 }),
			ArrowUp: () => jog({ y: 1 }),
			ArrowDown: () => jog({ y: -1 }),
			PageUp: () => jog({ z: 1 }),
			PageDown: () => jog({ z: -1 }),
			Home: () => home(e.shiftKey ? ['z'] : ['x', 'y']),
			End: () => home(['x', 'y', 'z']),
			'1': () => (step = JOG_STEPS[0]),
			'2': () => (step = JOG_STEPS[1]),
			'3': () => (step = JOG_STEPS[2]),
			'4': () => (step = JOG_STEPS[3]),
			'?': () => (showKeys = !showKeys),
			Escape: () => (showKeys = false)
		};
		const fn = map[e.key];
		if (!fn) return;
		e.preventDefault();
		fn();
	}

	function extrude(sign: 1 | -1) {
		const len = Number(extrudeLength);
		if (!Number.isFinite(len) || len <= 0 || len > MAX_EXTRUDE_MM) return;
		void send({ action: 'extrude', amount: sign * len, ...(profile.extruders > 1 ? { tool: toolKey } : {}) });
	}

	async function selectTool(i: number) {
		if (await send({ action: 'tool', tool: `tool${i}` })) activeTool = i;
	}

	function runCustom(c: Extract<CustomControl, { kind: 'command' | 'script' }>, values: Record<string, string>) {
		const ask = c.confirm ? { title: c.name, body: c.confirm, confirmLabel: 'Run' } : undefined;
		if (c.kind === 'script') void control(live.id, { action: 'custom', name: c.name, script: c.script, parameters: values }, { ask, done: `${c.name}: sent` });
		else void control(live.id, { action: 'custom', name: c.name, commands: c.commands.map((cmd) => fillTemplate(cmd, values)) }, { ask, done: `${c.name}: sent` });
	}

	const KEYS = [
		['← →', 'Jog X'],
		['↑ ↓', 'Jog Y'],
		['PgUp PgDn', 'Jog Z'],
		['Home', 'Home X/Y'],
		['⇧ Home', 'Home Z'],
		['End', 'Home all'],
		['1–4', 'Step size'],
		['?', 'This help']
	];

	const fill = (v: number, min: number, max: number) => ((Number(v) - min) / (max - min)) * 100;
	const fmtStep = (n: number) => (n < 1 ? n.toFixed(1) : String(n));
	const dims = $derived(`${profile.volume.width} × ${profile.volume.formFactor === 'circular' ? profile.volume.width : profile.volume.depth} × ${profile.volume.height} mm`);
</script>

{#snippet padButton(label: string, dir: Partial<Record<MoveAxis, Direction>>, Icon: typeof ArrowUp, cls = '')}
	{@const fits = stepFits(step, profile, Object.keys(dir) as MoveAxis[])}
	<button
		class="grid size-12 place-items-center max-sm:size-16 rounded-xl border border-border bg-background text-foreground shadow-surface transition-all hover:border-primary/50 hover:bg-primary/5 hover:text-primary active:scale-95 disabled:pointer-events-none disabled:opacity-40 {cls}"
		aria-label={label}
		title={fits ? `${label} ${fmtStep(step)} mm` : `${fmtStep(step)} mm is longer than this axis`}
		disabled={!canMove || !fits}
		onclick={() => jog(dir)}
	>
		<Icon class="size-5" />
	</button>
{/snippet}

<div class="space-y-4" data-testid="control-tab">
	{#if !canControl}
		<div class="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-[0.8125rem] text-muted-foreground" data-testid="viewer-hint">
			<Lock class="size-4 shrink-0" />Your role can only watch this printer. Ask an admin for operator access to move it.
		</div>
	{:else if blocked}
		<div class="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5 text-[0.8125rem]" data-testid="movement-blocked">
			<CircleAlert class="size-4 shrink-0 text-warning" />
			<span>{blocked}{#if connected}{' '}Speed, flow and fan still work.{/if}</span>
		</div>
	{:else if s.state === 'paused'}
		<div class="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5 text-[0.8125rem]">
			<CircleAlert class="size-4 shrink-0 text-warning" />
			<span>The print is paused. You can move the head; make sure it’s back in place (or that OctoPrint’s resume script restores it) before resuming.</span>
		</div>
	{/if}

	<!-- Profile summary: what the controls below adapt to. -->
	<div class="card flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 text-xs">
		<span class="flex items-center gap-2 font-medium"><Box class="size-4 text-primary" />{profile.name}{#if profile.model}<span class="font-normal text-muted-foreground">· {profile.model}</span>{/if}</span>
		<span class="text-muted-foreground">Build volume <span class="font-mono text-foreground">{dims}</span>{profile.volume.formFactor === 'circular' ? ' (round)' : ''}</span>
		<span class="text-muted-foreground">Extruders <span class="font-mono text-foreground">{profile.extruders}</span>{profile.sharedNozzle ? ' (shared nozzle)' : ''}</span>
		<span class="flex gap-1.5">
			<span class="badge {profile.heatedBed ? 'badge-success' : ''}">{profile.heatedBed ? 'Heated bed' : 'No heated bed'}</span>
			{#if profile.heatedChamber}<span class="badge badge-success">Heated chamber</span>{/if}
			{#each inverted as a (a)}<span class="badge badge-primary" title="The buttons for this axis move the other way, as the profile says">{a.toUpperCase()} inverted</span>{/each}
		</span>
		{#if loadError}
			<span class="ml-auto flex items-center gap-1.5 text-danger" title={loadError}><CircleAlert class="size-3.5" />Couldn’t read the printer profile; using defaults</span>
		{:else if !info}
			<span class="ml-auto flex items-center gap-1.5 text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" />Loading profile…</span>
		{/if}
	</div>

	<div class="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
		<!-- Movement: the card takes focus so its keyboard shortcuts apply only while it has it. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<section
			class="card relative p-4 outline-none focus-visible:outline-none {padFocused ? 'border-primary/50 ring-3 ring-primary/15' : ''}"
			tabindex="0"
			aria-label="Jog controls. Arrow keys move X and Y, Page Up and Page Down move Z, Home homes."
			data-testid="jog-pad"
			onkeydown={onPadKey}
			onfocusin={() => (padFocused = true)}
			onfocusout={(e) => {
				if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) padFocused = false;
			}}
		>
			<div class="flex items-center gap-2">
				<h2 class="flex items-center gap-2 text-sm font-semibold"><Move class="size-4 text-primary" />Move</h2>
				<span class="text-[0.6875rem] touch:hidden {padFocused ? 'text-primary' : 'text-muted-foreground'}">{padFocused ? 'Keyboard active' : 'Click here to use the keyboard'}</span>
				<div class="relative ml-auto touch:hidden">
					<button class="btn btn-ghost btn-icon btn-sm" aria-label="Keyboard shortcuts" aria-expanded={showKeys} onclick={() => (showKeys = !showKeys)}><Keyboard /></button>
					{#if showKeys}
						<div class="card absolute top-full right-0 z-20 mt-1.5 w-60 p-3 shadow-surface-lg" role="dialog" aria-label="Keyboard shortcuts">
							<div class="mb-2 flex items-center justify-between">
								<p class="text-xs font-medium">Keyboard shortcuts</p>
								<button class="btn btn-ghost btn-icon btn-sm -mr-1" aria-label="Close" onclick={() => (showKeys = false)}><X /></button>
							</div>
							<dl class="space-y-1.5 text-xs">
								{#each KEYS as [k, what] (k)}
									<div class="flex items-center justify-between gap-3">
										<dt class="flex gap-1">{#each k.split(' ') as part (part)}<kbd class="kbd">{part}</kbd>{/each}</dt>
										<dd class="text-muted-foreground">{what}</dd>
									</div>
								{/each}
							</dl>
							<p class="mt-2.5 text-[0.6875rem] text-muted-foreground">Only while the Move card has focus.</p>
						</div>
					{/if}
				</div>
			</div>

			<div class="mt-4 flex flex-wrap items-start justify-center gap-x-5 gap-y-5 sm:justify-start sm:gap-8">
				<!-- X/Y pad -->
				<div>
					<p class="mb-2 text-center text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">X / Y</p>
					<div class="grid grid-cols-3 gap-1.5">
						<span></span>
						{@render padButton('Y+ (back)', { y: 1 }, ArrowUp)}
						<span></span>
						{@render padButton('X− (left)', { x: -1 }, ArrowLeft)}
						<button
							class="grid size-12 place-items-center max-sm:size-16 rounded-xl border border-border bg-surface text-muted-foreground transition-all hover:border-primary/50 hover:text-primary active:scale-95 disabled:pointer-events-none disabled:opacity-40"
							aria-label="Home X and Y"
							title="Home X and Y"
							disabled={!canMove}
							onclick={() => home(['x', 'y'])}><House class="size-5" /></button
						>
						{@render padButton('X+ (right)', { x: 1 }, ArrowRight)}
						<span></span>
						{@render padButton('Y− (front)', { y: -1 }, ArrowDown)}
						<span></span>
					</div>
				</div>
				<!-- Z -->
				<div>
					<p class="mb-2 text-center text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Z</p>
					<div class="grid gap-1.5">
						{@render padButton('Z+ (up)', { z: 1 }, ChevronsUp)}
						<button
							class="grid size-12 place-items-center max-sm:size-16 rounded-xl border border-border bg-surface text-muted-foreground transition-all hover:border-primary/50 hover:text-primary active:scale-95 disabled:pointer-events-none disabled:opacity-40"
							aria-label="Home Z"
							title="Home Z"
							disabled={!canMove}
							onclick={() => home(['z'])}><House class="size-5" /></button
						>
						{@render padButton('Z− (down)', { z: -1 }, ChevronsDown)}
					</div>
				</div>
				<!-- Step and homing -->
				<div class="min-w-48 flex-1 space-y-4 max-sm:basis-full">
					<div>
						<p class="label">Step<span class="sm:hidden">{' '}(mm)</span></p>
						<div class="inline-flex rounded-lg border border-border bg-surface p-0.5 max-sm:flex max-sm:w-full" role="radiogroup" aria-label="Step size">
							{#each JOG_STEPS as n (n)}
								<button
									role="radio"
									aria-checked={step === n}
									class="h-7 min-w-12 rounded-md px-2 font-mono text-xs tabular-nums transition-colors max-sm:flex-1 touch:h-10 touch:text-sm {step === n ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
									disabled={!stepFits(n, profile, ['z']) && !stepFits(n, profile, ['x', 'y'])}
									onclick={() => (step = n)}>{fmtStep(n)}</button
								>
							{/each}
						</div>
					</div>
					<div class="flex flex-wrap gap-1.5 max-sm:[&>.btn]:flex-1">
						<button class="btn btn-secondary btn-sm" disabled={!canMove} onclick={() => home(['x', 'y', 'z'])}><House />Home all</button>
						<button class="btn btn-ghost btn-sm" disabled={!canMove} onclick={() => send({ action: 'motors_off' }, { done: 'Motors off' })} title="M18: the steppers stop holding; positions are lost until the next homing"><PowerOff />Motors off</button>
					</div>
					{#if s.currentZ != null}
						<p class="text-xs text-muted-foreground">Last Z <span class="font-mono text-foreground">{s.currentZ.toFixed(2)} mm</span></p>
					{/if}
				</div>
			</div>
		</section>

		<!-- Extruder -->
		<section class="card p-4">
			<h2 class="flex items-center gap-2 text-sm font-semibold"><ArrowDownToLine class="size-4 text-primary" />Extruder</h2>
			{#if profile.extruders > 1}
				<div class="mt-3">
					<p class="label">Tool</p>
					<div class="inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5" role="radiogroup" aria-label="Active tool">
						{#each { length: profile.extruders } as _, i (i)}
							<button
								role="radio"
								aria-checked={activeTool === i}
								class="h-7 rounded-md px-2.5 text-xs transition-colors touch:h-10 {activeTool === i ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
								disabled={!canMove}
								title="Select tool {i + 1} (T{i})"
								onclick={() => selectTool(i)}>Tool {i + 1}</button
							>
						{/each}
					</div>
				</div>
			{/if}
			<div class="mt-3">
				<label class="label" for="extrude-length">Length</label>
				<div class="flex flex-wrap items-center gap-1.5">
					<div class="relative">
						<input id="extrude-length" class="input h-8 w-24 pr-9 text-right font-mono text-xs" type="number" min="0.1" max={MAX_EXTRUDE_MM} step="0.1" bind:value={extrudeLength} disabled={!canMove} />
						<span class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[0.6875rem] text-muted-foreground">mm</span>
					</div>
					{#each EXTRUDE_LENGTHS as n (n)}
						<button class="btn btn-ghost btn-sm font-mono {Number(extrudeLength) === n ? 'bg-accent text-foreground' : ''}" disabled={!canMove} onclick={() => (extrudeLength = n)}>{n}</button>
					{/each}
				</div>
			</div>
			<div class="mt-3 flex flex-wrap gap-1.5 max-sm:[&>.btn]:flex-1">
				<button class="btn btn-secondary btn-sm" disabled={!canMove} onclick={() => extrude(1)}><ArrowDownToLine />Extrude</button>
				<button class="btn btn-secondary btn-sm" disabled={!canMove} onclick={() => extrude(-1)}><ArrowUpFromLine />Retract</button>
			</div>
			<p class="mt-3 flex items-center gap-1.5 text-xs {cold && connected ? 'text-warning' : 'text-muted-foreground'}">
				<Thermometer class="size-3.5" />
				{#if hotend == null}
					Hotend temperature unknown.
				{:else if cold}
					Hotend at {hotend.toFixed(0)}°: most firmware refuses to extrude below {MIN_EXTRUDE_TEMP}°.
				{:else}
					Hotend at {hotend.toFixed(0)}°.
				{/if}
			</p>
		</section>

		<!-- Speed & flow -->
		<section class="card p-4">
			<h2 class="flex items-center gap-2 text-sm font-semibold"><Gauge class="size-4 text-primary" />Speed &amp; flow</h2>
			<p class="mt-0.5 text-xs text-muted-foreground">Overrides apply to the running print too.</p>
			{#each [{ key: 'feedrate', label: 'Feed rate', code: 'M220', range: FEEDRATE }, { key: 'flowrate', label: 'Flow rate', code: 'M221', range: FLOWRATE }] as r (r.key)}
				<div class="mt-3">
					<div class="flex items-baseline justify-between">
						<label class="label" for="r-{r.key}">{r.label} <span class="font-mono text-[0.625rem] text-muted-foreground/70">{r.code}</span></label>
						<span class="font-mono text-sm font-semibold tabular-nums">{r.key === 'feedrate' ? feed : flow}%</span>
					</div>
					<div class="flex items-center gap-2">
						{#if r.key === 'feedrate'}
							<input id="r-{r.key}" class="range" style="--fill:{fill(feed, r.range.min, r.range.max)}%" type="range" min={r.range.min} max={r.range.max} step="1" bind:value={feed} disabled={!canTune} />
						{:else}
							<input id="r-{r.key}" class="range" style="--fill:{fill(flow, r.range.min, r.range.max)}%" type="range" min={r.range.min} max={r.range.max} step="1" bind:value={flow} disabled={!canTune} />
						{/if}
						<button class="btn btn-secondary btn-sm" disabled={!canTune} onclick={() => send({ action: r.key, factor: r.key === 'feedrate' ? feed : flow }, { done: `${r.label} ${r.key === 'feedrate' ? feed : flow}%` })}>Set</button>
						<button
							class="btn btn-ghost btn-sm"
							disabled={!canTune}
							title="Back to 100%"
							onclick={() => {
								if (r.key === 'feedrate') feed = 100;
								else flow = 100;
								void send({ action: r.key, factor: 100 }, { done: `${r.label} 100%` });
							}}>Reset</button
						>
					</div>
				</div>
			{/each}
		</section>

		<!-- Fan -->
		<section class="card p-4">
			<h2 class="flex items-center gap-2 text-sm font-semibold"><Fan class="size-4 text-primary" />Part cooling fan</h2>
			<div class="mt-3 flex items-baseline justify-between">
				<label class="label" for="fan-speed">Speed <span class="font-mono text-[0.625rem] text-muted-foreground/70">M106 / M107</span></label>
				<span class="font-mono text-sm font-semibold tabular-nums">{fan}%</span>
			</div>
			<div class="flex items-center gap-2">
				<input id="fan-speed" class="range" style="--fill:{fan}%" type="range" min="0" max="100" step="5" bind:value={fan} disabled={!canTune} />
				<button class="btn btn-secondary btn-sm" disabled={!canTune} onclick={() => send({ action: 'fan', speed: fan }, { done: fan ? `Fan ${fan}%` : 'Fan off' })}>Set</button>
			</div>
			<div class="mt-3 flex gap-1.5 max-sm:[&>.btn]:flex-1">
				<button class="btn btn-secondary btn-sm" disabled={!canTune} onclick={() => ((fan = 100), send({ action: 'fan', speed: 100 }, { done: 'Fan on' }))}><Fan />On</button>
				<button class="btn btn-ghost btn-sm" disabled={!canTune} onclick={() => ((fan = 0), send({ action: 'fan', speed: 0 }, { done: 'Fan off' }))}><PowerOff />Off</button>
			</div>
		</section>
	</div>

	<!-- OctoPrint's custom controls -->
	{#if info && (info.controls.length || info.controlsError)}
		<section class="card p-4" data-testid="custom-controls">
			<h2 class="flex items-center gap-2 text-sm font-semibold"><SlidersHorizontal class="size-4 text-primary" />{printer.kind === 'moonraker' ? 'Macros' : 'Custom controls'}</h2>
			{#if printer.kind === 'moonraker'}
				<p class="mt-0.5 text-xs text-muted-foreground">Klipper’s <span class="font-mono">gcode_macro</span>s (names starting with <span class="font-mono">_</span> are hidden). While printing, you’ll be asked first.</p>
			{:else}
			<p class="mt-0.5 text-xs text-muted-foreground">From OctoPrint’s <span class="font-mono">config.yaml</span> (<span class="font-mono">controls</span>). Commands are sent as G-code; while printing, you’ll be asked first.</p>
			{/if}
			<div class="mt-3">
				{#if info.controlsError}
					<p class="text-xs text-danger">Couldn’t load them: {info.controlsError}</p>
				{:else}
					{#key info}<CustomControls controls={info.controls} logs={live.logs} disabled={!canTune} onrun={runCustom} />{/key}
				{/if}
			</div>
		</section>
	{/if}
</div>
