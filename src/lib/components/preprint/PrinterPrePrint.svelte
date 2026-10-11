<script lang="ts">
	import { api, errorMessage } from '#lib/client/api.ts';
	import { BED_TEMP, MODE_LABEL, commandLines, patternError, type PrepGlobal, type PrepMode, type PrepPrinter } from '#lib/preprint.ts';

	/** The "Before each print" part of the printer dialog (admins). The dialog calls `save()`. */
	let { printerId }: { printerId: string } = $props();

	let form = $state<PrepPrinter | null>(null);
	let defaults = $state<PrepGlobal | null>(null);
	let kindCommand = $state('');
	let loadError = $state<string | null>(null);
	let initial = '';

	$effect(() => {
		const id = printerId;
		form = null;
		api.get<{ settings: PrepPrinter; defaults: PrepGlobal; kindCommand: string }>(`/api/printers/${encodeURIComponent(id)}/preprint/settings`)
			.then((r) => {
				if (id !== printerId) return;
				form = r.settings;
				defaults = r.defaults;
				kindCommand = r.kindCommand;
				initial = JSON.stringify(r.settings);
			})
			.catch((err) => (loadError = errorMessage(err)));
	});

	export function problem(): string | null {
		if (!form) return null;
		return patternError(form.snippet.skipPattern) ?? patternError(form.leveling.skipPattern);
	}

	/** Saves when something changed. Throws with a message for people. */
	export async function save(): Promise<boolean> {
		if (!form || JSON.stringify(form) === initial) return false;
		await api.put(`/api/printers/${encodeURIComponent(printerId)}/preprint/settings`, form);
		initial = JSON.stringify(form);
		return true;
	}

	const MODES: PrepMode[] = ['default', 'custom', 'none'];
	const summary = (on: boolean, what: string) => (on ? what : 'off');
	const defLevel = $derived(defaults ? summary(defaults.leveling.enabled, commandLines(kindCommand === 'G28\nG29' ? defaults.leveling.octoprintCommand : defaults.leveling.klipperCommand).join(', ') || kindCommand) : '…');
	const defSnippet = $derived(defaults ? summary(defaults.snippet.enabled && !!commandLines(defaults.snippet.gcode).length, `${commandLines(defaults.snippet.gcode).length} lines`) : '…');
	const enabledLabel = $derived(form ? [form.leveling.mode !== 'none' && (form.leveling.mode === 'custom' || defaults?.leveling.enabled) ? 'leveling' : null, form.snippet.mode !== 'none' && (form.snippet.mode === 'custom' || defaults?.snippet.enabled) ? 'G-code' : null].filter(Boolean).join(' + ') || 'nothing' : '');
</script>

<details class="rounded-lg border border-border px-3 py-2.5" data-testid="printer-preprint" open={form ? form.leveling.mode !== 'default' || form.snippet.mode !== 'default' : false}>
	<summary class="cursor-pointer text-[0.8125rem] font-medium select-none">Before each print <span class="font-normal text-muted-foreground">· {enabledLabel}</span></summary>
	{#if loadError}
		<p class="mt-3 text-xs text-danger">{loadError}</p>
	{:else if form}
		<div class="mt-3 space-y-4">
			<fieldset class="space-y-2">
				<legend class="label">Level the bed</legend>
				<div class="grid grid-cols-3 gap-1 rounded-xl border border-border bg-surface p-1" role="radiogroup" aria-label="Level the bed">
					{#each MODES as m (m)}
						<button type="button" role="radio" aria-checked={form.leveling.mode === m} onclick={() => (form!.leveling.mode = m)} class="min-h-9 rounded-lg px-2 py-1.5 text-[0.75rem] font-medium transition touch:min-h-11 {form.leveling.mode === m ? 'bg-card text-foreground shadow-surface ring-1 ring-primary/40' : 'text-muted-foreground hover:text-foreground'}">{MODE_LABEL[m]}</button>
					{/each}
				</div>
				{#if form.leveling.mode === 'default'}
					<p class="text-[0.6875rem] text-muted-foreground">The default (Settings → Before each print): <span class="font-mono text-foreground/80">{defLevel}</span>.</p>
				{:else if form.leveling.mode === 'custom'}
					<label class="block">
						<span class="label">Command</span>
						<textarea class="input min-h-14 py-2 font-mono text-[0.8125rem]" rows="2" placeholder={kindCommand} bind:value={form.leveling.command} data-testid="printer-level-command"></textarea>
					</label>
					<label class="block">
						<span class="label">Also skip when the file contains <span class="font-normal text-muted-foreground">· optional</span></span>
						<input class="input font-mono text-[0.8125rem]" placeholder="START_PRINT" bind:value={form.leveling.skipPattern} />
						{#if patternError(form.leveling.skipPattern)}<span class="mt-1 block text-[0.6875rem] text-danger">{patternError(form.leveling.skipPattern)}</span>{/if}
					</label>
					<div class="flex flex-wrap items-center gap-3">
						<label class="flex min-h-9 items-center gap-2 text-[0.8125rem]"><input type="checkbox" class="size-4 accent-[var(--primary)]" bind:checked={form.leveling.heatBed} />Heat the bed first</label>
						{#if form.leveling.heatBed}
							<label class="flex items-center gap-2 text-xs text-muted-foreground">else <input class="input h-8 w-20" type="number" min={BED_TEMP.min} max={BED_TEMP.max} bind:value={form.leveling.bedTemp} /> °C</label>
						{/if}
					</div>
				{:else}
					<p class="text-[0.6875rem] text-muted-foreground">Never levels before a print on this printer.</p>
				{/if}
			</fieldset>

			<fieldset class="space-y-2">
				<legend class="label">Pre-print G-code</legend>
				<div class="grid grid-cols-3 gap-1 rounded-xl border border-border bg-surface p-1" role="radiogroup" aria-label="Pre-print G-code">
					{#each MODES as m (m)}
						<button type="button" role="radio" aria-checked={form.snippet.mode === m} onclick={() => (form!.snippet.mode = m)} class="min-h-9 rounded-lg px-2 py-1.5 text-[0.75rem] font-medium transition touch:min-h-11 {form.snippet.mode === m ? 'bg-card text-foreground shadow-surface ring-1 ring-primary/40' : 'text-muted-foreground hover:text-foreground'}">{MODE_LABEL[m]}</button>
					{/each}
				</div>
				{#if form.snippet.mode === 'default'}
					<p class="text-[0.6875rem] text-muted-foreground">The default: <span class="font-mono text-foreground/80">{defSnippet}</span>.</p>
				{:else if form.snippet.mode === 'custom'}
					<textarea class="input min-h-24 py-2 font-mono text-[0.8125rem]" rows="4" placeholder={'G28\nM420 S1'} aria-label="Pre-print G-code for this printer" bind:value={form.snippet.gcode} data-testid="printer-snippet"></textarea>
					<div class="grid gap-2 sm:grid-cols-2">
						<select class="input" aria-label="Already in the file means" bind:value={form.snippet.match}>
							<option value="exact">Same commands and parameters</option>
							<option value="commands">Same commands, any parameters</option>
						</select>
						<input class="input font-mono text-[0.8125rem]" placeholder="skip if file contains…" aria-label="Also skip when the file contains" bind:value={form.snippet.skipPattern} />
					</div>
					{#if patternError(form.snippet.skipPattern)}<span class="block text-[0.6875rem] text-danger">{patternError(form.snippet.skipPattern)}</span>{/if}
				{:else}
					<p class="text-[0.6875rem] text-muted-foreground">No pre-print G-code on this printer.</p>
				{/if}
			</fieldset>
		</div>
	{/if}
</details>
