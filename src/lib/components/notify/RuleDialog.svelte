<script lang="ts">
	import { Save } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import Switch from '../Switch.svelte';
	import ChannelIcon from './ChannelIcon.svelte';
	import { printers } from '#lib/client/state.svelte.ts';
	import { EVENT_INFO, EVENT_KINDS, type ChannelInfo, type EventKind, type Rule } from '#lib/notify.ts';

	/** Edits one routing rule: which printers × which events → which channels. */
	let {
		open = $bindable(false),
		rule = null,
		channels,
		onsave
	}: { open: boolean; rule: Rule | null; channels: ChannelInfo[]; onsave: (r: Rule) => Promise<boolean> } = $props();

	const blank = (): Rule => ({ id: '', name: '', enabled: true, printers: 'all', events: ['print.finished', 'print.failed'], channels: channels.map((c) => c.id) });
	let form = $state<Rule>(blank());
	let allPrinters = $state(true);
	let saving = $state(false);

	let lastOpen = false;
	$effect(() => {
		if (open && !lastOpen) {
			form = rule ? structuredClone($state.snapshot(rule)) : blank();
			allPrinters = form.printers === 'all';
		}
		lastOpen = open;
	});

	const GROUPS = ['Prints', 'Printer', 'Other features'] as const;
	const kinds = (g: (typeof GROUPS)[number]) => EVENT_KINDS.filter((k) => EVENT_INFO[k].group === g);
	const selectedPrinters = $derived(form.printers === 'all' ? [] : form.printers);

	function toggle<T>(list: T[], v: T): T[] {
		return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		const ok = await onsave({ ...form, printers: allPrinters ? 'all' : selectedPrinters });
		saving = false;
		if (ok) open = false;
	}
</script>

<Dialog bind:open title={rule ? `Edit ${rule.name}` : 'Add a rule'} description="Which printers and events go to which channels." width="max-w-2xl">
	<form id="rule-form" class="space-y-4" onsubmit={submit}>
		<div class="grid gap-3 sm:grid-cols-[1fr_auto]">
			<div>
				<label class="label" for="rule-name">Name</label>
				<input id="rule-name" class="input" placeholder="e.g. Failures to my phone" bind:value={form.name} />
			</div>
			<label class="flex items-center gap-2 self-end pb-2 text-[13px]"><Switch label="Enabled" bind:checked={form.enabled} />Enabled</label>
		</div>

		<fieldset class="space-y-2">
			<legend class="label">Printers</legend>
			<label class="flex items-center gap-2 text-[13px]"><Switch label="All printers" bind:checked={allPrinters} />All printers (also events that aren’t about one printer)</label>
			{#if !allPrinters}
				<div class="flex flex-wrap gap-2">
					{#each printers.list as p (p.id)}
						<label class="flex min-h-9 items-center gap-2 rounded-lg border border-border px-2.5 text-xs {selectedPrinters.includes(p.id) ? 'border-primary/50 bg-primary-soft' : ''}">
							<input type="checkbox" class="accent-[var(--primary)]" checked={selectedPrinters.includes(p.id)} onchange={() => (form.printers = toggle(selectedPrinters, p.id))} />{p.name}
						</label>
					{:else}
						<p class="text-xs text-muted-foreground">No printers yet.</p>
					{/each}
				</div>
			{/if}
		</fieldset>

		<fieldset class="space-y-3">
			<legend class="label">Events</legend>
			{#each GROUPS as g (g)}
				<div>
					<p class="mb-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{g}</p>
					<div class="grid gap-1.5 sm:grid-cols-2">
						{#each kinds(g) as k (k)}
							<label class="flex min-h-10 items-start gap-2.5 rounded-lg border border-border px-2.5 py-2 text-[13px] {form.events.includes(k) ? 'border-primary/50 bg-primary-soft' : ''}" title={EVENT_INFO[k].hint}>
								<input type="checkbox" class="mt-0.5 size-4 accent-[var(--primary)]" checked={form.events.includes(k)} onchange={() => (form.events = toggle<EventKind>(form.events, k))} />
								<span class="min-w-0">{EVENT_INFO[k].label}<span class="block text-[11px] text-muted-foreground">{EVENT_INFO[k].hint}</span></span>
							</label>
						{/each}
					</div>
				</div>
			{/each}
		</fieldset>

		<fieldset class="space-y-2">
			<legend class="label">Channels</legend>
			<div class="flex flex-wrap gap-2">
				{#each channels as c (c.id)}
					<label class="flex min-h-9 items-center gap-2 rounded-lg border border-border px-2.5 text-xs {form.channels.includes(c.id) ? 'border-primary/50 bg-primary-soft' : ''}">
						<input type="checkbox" class="accent-[var(--primary)]" checked={form.channels.includes(c.id)} onchange={() => (form.channels = toggle(form.channels, c.id))} />
						<ChannelIcon type={c.type} class="size-3.5 text-muted-foreground" />{c.name}
					</label>
				{:else}
					<p class="text-xs text-muted-foreground">Add a channel first.</p>
				{/each}
			</div>
		</fieldset>
	</form>
	{#snippet footer()}
		<button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
		<button form="rule-form" class="btn btn-primary" disabled={saving}><Save />{rule ? 'Save rule' : 'Add rule'}</button>
	{/snippet}
</Dialog>
