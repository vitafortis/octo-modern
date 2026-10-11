<script lang="ts">
	import { ChevronRight, FileCode2, Play } from '@lucide/svelte';
	import { untrack } from 'svelte';
	import Self from './CustomControls.svelte';
	import { renderOutput, type CustomControl } from '#lib/control/custom.ts';

	/** OctoPrint's custom controls, rendered recursively: sections, command/script buttons with inputs, feedback lines. */
	let {
		controls,
		logs,
		disabled = false,
		layout = 'vertical',
		onrun
	}: {
		controls: CustomControl[];
		logs: readonly string[];
		disabled?: boolean;
		layout?: 'vertical' | 'horizontal' | 'horizontal_grid';
		onrun: (c: Extract<CustomControl, { kind: 'command' | 'script' }>, values: Record<string, string>) => void;
	} = $props();

	// Input values per control (keyed by position, which is stable for a loaded tree).
	const initial = (list: CustomControl[]) => list.map((c) => (c.kind === 'command' || c.kind === 'script' ? Object.fromEntries(c.inputs.map((inp) => [inp.parameter, inp.default])) : {}));
	let values = $state<Record<string, string>[]>(initial(untrack(() => controls)));

	const box = $derived(layout === 'horizontal' ? 'flex flex-wrap items-start gap-2' : layout === 'horizontal_grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2' : 'flex flex-col gap-2');
</script>

<div class={box}>
	{#each controls as c, i (i)}
		{#if c.kind === 'section'}
			<details class="group w-full rounded-lg border border-border bg-surface/60" open={!c.collapsed}>
				<summary class="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-medium select-none">
					<ChevronRight class="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />{c.name ?? 'Controls'}
				</summary>
				<div class="px-3 pb-3">
					<Self controls={c.children} {logs} {disabled} layout={c.layout} {onrun} />
				</div>
			</details>
		{:else if c.kind === 'output'}
			{@const text = renderOutput(c, logs)}
			<div class="flex items-center gap-2 text-xs">
				{#if c.name}<span class="text-muted-foreground">{c.name}</span>{/if}
				<span class="font-mono {text ? 'text-foreground' : 'text-muted-foreground/70'}">{text ?? 'no reading yet'}</span>
			</div>
		{:else}
			{@const v = values[i]}
			<form
				class="flex flex-wrap items-center gap-2"
				onsubmit={(e) => {
					e.preventDefault();
					onrun(c, { ...v });
				}}
			>
				{#each c.inputs as inp (inp.parameter)}
					<label class="flex items-center gap-2 text-xs text-muted-foreground">
						<span>{inp.name}</span>
						{#if inp.slider}
							<input class="range w-28!" style="--fill:{((Number(v[inp.parameter]) - inp.slider.min) / (inp.slider.max - inp.slider.min)) * 100}%" type="range" min={inp.slider.min} max={inp.slider.max} step={inp.slider.step} bind:value={v[inp.parameter]} {disabled} />
							<span class="w-9 font-mono text-foreground tabular-nums">{v[inp.parameter]}</span>
						{:else}
							<input class="input h-7 w-24 font-mono text-xs" bind:value={v[inp.parameter]} {disabled} />
						{/if}
					</label>
				{/each}
				<button class="btn btn-secondary btn-sm" {disabled} title={c.kind === 'script' ? `Runs the GCODE script ${c.script}` : c.commands.join('\n')}>
					{#if c.kind === 'script'}<FileCode2 />{:else}<Play />{/if}{c.name}
				</button>
			</form>
		{/if}
	{/each}
</div>
