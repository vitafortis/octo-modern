<script lang="ts">
	import { onMount } from 'svelte';
	import { ListChecks, LoaderCircle } from '@lucide/svelte';
	import Switch from '../Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { BED_TEMP, DEFAULT_LEVEL_COMMAND, TIMEOUT_MIN, patternError, type PrepGlobal } from '#lib/preprint.ts';

	/** Admins: the default leveling and pre-print G-code for every printer (each printer can override it). */
	let form = $state<PrepGlobal | null>(null);
	let saving = $state(false);

	onMount(async () => {
		try {
			form = await api.get<PrepGlobal>('/api/settings/preprint');
		} catch (err) {
			toast('error', 'Couldn’t load the pre-print settings', errorMessage(err));
		}
	});

	const problems = $derived(form ? [patternError(form.snippet.skipPattern), patternError(form.leveling.skipPattern)].filter(Boolean) : []);

	async function save() {
		if (!form) return;
		saving = true;
		try {
			form = await api.put<PrepGlobal>('/api/settings/preprint', form);
			toast('success', 'Pre-print defaults saved');
		} catch (err) {
			toast('error', 'Couldn’t save', errorMessage(err));
		} finally {
			saving = false;
		}
	}
</script>

<section class="card p-5" id="before-each-print" data-testid="preprint-settings">
	<h2 class="flex items-center gap-2 text-sm font-semibold"><ListChecks class="size-4 text-primary" />Before each print</h2>
	<p class="mt-1 max-w-2xl text-xs text-muted-foreground">
		Level the bed and run your own G-code before every print octo·modern starts (Files, the queue, library sends, slicer uploads, print again), unless the file already does it:
		octo·modern reads the start of the file first. Each printer can use these defaults, its own, or none (edit the printer). Prints started in OctoPrint’s or Mainsail’s own UI aren’t affected.
	</p>
	{#if form}
		<div class="mt-5 grid gap-5 lg:grid-cols-2">
			<div class="space-y-3 rounded-xl border border-border p-4">
				<div class="flex items-start justify-between gap-4">
					<div>
						<p class="text-[0.8125rem] font-medium">Level the bed</p>
						<p class="text-xs text-muted-foreground">Skipped when the file levels itself (G29, G80, BED_MESH_CALIBRATE). Loading a saved mesh (M420 S1, BED_MESH_PROFILE LOAD) doesn’t count.</p>
					</div>
					<Switch label="Level the bed before each print" bind:checked={form.leveling.enabled} />
				</div>
				<div class="grid gap-3 sm:grid-cols-2 {form.leveling.enabled ? '' : 'opacity-60'}">
					<label>
						<span class="label">OctoPrint (Marlin) command</span>
						<textarea class="input min-h-16 py-2 font-mono text-[0.8125rem]" rows="2" placeholder={DEFAULT_LEVEL_COMMAND.octoprint} bind:value={form.leveling.octoprintCommand} data-testid="prep-level-octoprint"></textarea>
					</label>
					<label>
						<span class="label">Klipper command</span>
						<textarea class="input min-h-16 py-2 font-mono text-[0.8125rem]" rows="2" placeholder={DEFAULT_LEVEL_COMMAND.moonraker} bind:value={form.leveling.klipperCommand}></textarea>
					</label>
					<label class="sm:col-span-2">
						<span class="label">Also skip when the file contains <span class="font-normal text-muted-foreground">· optional</span></span>
						<input class="input font-mono text-[0.8125rem]" placeholder="START_PRINT   or   /^PRINT_START\b/i" bind:value={form.leveling.skipPattern} />
						<span class="mt-1 block text-[0.6875rem] {patternError(form.leveling.skipPattern) ? 'text-danger' : 'text-muted-foreground'}">{patternError(form.leveling.skipPattern) ?? 'For start macros that level inside (Klipper’s START_PRINT, say). Plain text, or /regex/flags; matched against each command, comments ignored.'}</span>
					</label>
					<div class="flex items-center justify-between gap-3 sm:col-span-2">
						<div>
							<p class="text-[0.8125rem] font-medium">Heat the bed first</p>
							<p class="text-[0.6875rem] text-muted-foreground">To the file’s first bed temperature (M140/M190, or BED= of a start macro), else the temperature here; waits with M190.</p>
						</div>
						<Switch label="Heat the bed before leveling" bind:checked={form.leveling.heatBed} />
					</div>
					{#if form.leveling.heatBed}
						<label>
							<span class="label">Fallback bed temperature (°C)</span>
							<input class="input" type="number" min={BED_TEMP.min} max={BED_TEMP.max} bind:value={form.leveling.bedTemp} />
						</label>
					{/if}
				</div>
			</div>

			<div class="space-y-3 rounded-xl border border-border p-4">
				<div class="flex items-start justify-between gap-4">
					<div>
						<p class="text-[0.8125rem] font-medium">Pre-print G-code</p>
						<p class="text-xs text-muted-foreground">Runs after leveling, before the file. Skipped when every command of it is already in the file’s start, in this order.</p>
					</div>
					<Switch label="Run pre-print G-code before each print" bind:checked={form.snippet.enabled} />
				</div>
				<div class="space-y-3 {form.snippet.enabled ? '' : 'opacity-60'}">
					<label class="block">
						<span class="label">G-code</span>
						<textarea class="input min-h-28 py-2 font-mono text-[0.8125rem]" rows="5" placeholder={'G28\nM420 S1 ; load the saved mesh\nG92 E0'} bind:value={form.snippet.gcode} data-testid="prep-snippet"></textarea>
					</label>
					<label class="block">
						<span class="label">“Already in the file” means</span>
						<select class="input" bind:value={form.snippet.match}>
							<option value="exact">The same commands with the same parameters</option>
							<option value="commands">The same commands, whatever their parameters</option>
						</select>
					</label>
					<label class="block">
						<span class="label">Also skip when the file contains <span class="font-normal text-muted-foreground">· optional</span></span>
						<input class="input font-mono text-[0.8125rem]" placeholder="START_PRINT" bind:value={form.snippet.skipPattern} />
						<span class="mt-1 block text-[0.6875rem] {patternError(form.snippet.skipPattern) ? 'text-danger' : 'text-muted-foreground'}">{patternError(form.snippet.skipPattern) ?? 'Plain text, or /regex/flags.'}</span>
					</label>
				</div>
			</div>
		</div>
		<div class="mt-4 flex flex-wrap items-end gap-3">
			<label>
				<span class="label">Give each step up to (minutes)</span>
				<input class="input w-40" type="number" min={TIMEOUT_MIN.min} max={TIMEOUT_MIN.max} bind:value={form.timeoutMin} data-testid="prep-timeout" />
			</label>
			<button class="btn btn-primary touch:h-11" disabled={saving || problems.length > 0} onclick={save} data-testid="prep-save">{#if saving}<LoaderCircle class="animate-spin" />{/if}Save</button>
			<p class="basis-full text-[0.6875rem] text-muted-foreground">While the steps run the printer shows “Preparing” with Cancel; if one fails or takes longer than this, the print isn’t started and a <b class="font-medium text-foreground">Pre-print steps failed</b> notification goes out.</p>
		</div>
	{/if}
</section>
