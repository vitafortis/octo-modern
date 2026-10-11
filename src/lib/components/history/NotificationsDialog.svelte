<script lang="ts">
	import { BellRing, LoaderCircle, Plus, Send, Trash2 } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import Switch from '../Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { toast } from '#lib/client/state.svelte.ts';

	/** Admins: where to send a message when a print ends (ntfy, Discord, webhook). */
	let { open = $bindable(false) }: { open: boolean } = $props();

	type Kind = 'ntfy' | 'discord' | 'webhook';
	type Result = 'success' | 'failed' | 'cancelled' | 'spool.low' | 'maintenance.due';
	interface Channel {
		id?: string;
		kind: Kind;
		name: string;
		enabled: boolean;
		on: Result[];
		config: Record<string, string>;
		/** Hints from the server; the inputs below hold new values. */
		secrets: Record<string, string>;
		lastError?: string | null;
		lastSentAt?: string | null;
		input: Record<string, string>;
	}

	let channels = $state<Channel[]>([]);
	let loading = $state(false);
	let saving = $state(false);
	let testing = $state<string | null>(null);

	const KINDS: { value: Kind; label: string }[] = [
		{ value: 'ntfy', label: 'ntfy' },
		{ value: 'discord', label: 'Discord' },
		{ value: 'webhook', label: 'Webhook (JSON)' }
	];
	const RESULTS: { value: Result; label: string }[] = [
		{ value: 'success', label: 'Finished' },
		{ value: 'failed', label: 'Failed' },
		{ value: 'cancelled', label: 'Cancelled' },
		{ value: 'spool.low', label: 'Spool low' },
		{ value: 'maintenance.due', label: 'Maintenance due' }
	];

	type Server = Omit<Channel, 'input'>;
	const fromServer = (list: Server[]): Channel[] => list.map((c) => ({ ...c, config: { ...c.config }, input: {} }));

	async function load() {
		loading = true;
		try {
			channels = fromServer((await api.get<{ channels: Server[] }>('/api/settings/notifications')).channels);
		} catch (err) {
			toast('error', 'Could not load the notification channels', errorMessage(err));
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open) void load();
	});

	function add() {
		channels.push({ kind: 'ntfy', name: '', enabled: true, on: ['success', 'failed'], config: { server: 'https://ntfy.sh', topic: '' }, secrets: {}, input: {} });
	}

	async function save(): Promise<boolean> {
		saving = true;
		try {
			const body = channels.map((c) => ({ id: c.id, kind: c.kind, name: c.name, enabled: c.enabled, on: c.on, config: c.config, secrets: c.input }));
			channels = fromServer((await api.put<{ channels: Server[] }>('/api/settings/notifications', { channels: body })).channels);
			toast('success', 'Notifications saved');
			return true;
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
			return false;
		} finally {
			saving = false;
		}
	}

	/** Saves (so the test uses what's on screen), then tests the channel at `index` (order is kept). */
	async function test(index: number) {
		if (!(await save())) return;
		const saved = channels[index];
		if (!saved?.id) return;
		testing = saved.id;
		try {
			await api.post('/api/settings/notifications/test', { id: saved.id });
			toast('success', 'Test sent', saved.name);
		} catch (err) {
			toast('error', 'The test didn’t go through', errorMessage(err));
		} finally {
			testing = null;
			await load();
		}
	}

	function toggle(c: Channel, r: Result) {
		c.on = c.on.includes(r) ? c.on.filter((x) => x !== r) : [...c.on, r];
	}
</script>

<Dialog bind:open title="Print notifications" description="A message when a print ends, to ntfy, Discord or any webhook." width="max-w-2xl">
	<div class="space-y-3">
		{#if loading && !channels.length}
			<div class="grid h-24 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
		{/if}
		{#each channels as c, i (c.id ?? `new-${i}`)}
			<div class="space-y-3 rounded-xl border border-border p-3.5">
				<div class="flex items-center gap-2">
					<Switch label="Enabled" bind:checked={c.enabled} />
					<select class="input h-8 w-40 text-xs" aria-label="Service" bind:value={c.kind}>
						{#each KINDS as k (k.value)}<option value={k.value}>{k.label}</option>{/each}
					</select>
					<input class="input h-8 flex-1 text-xs" placeholder="Name, e.g. Phone" aria-label="Name" bind:value={c.name} />
					<button class="btn btn-ghost btn-sm" disabled={!!testing || saving} onclick={() => test(i)}>
						{#if testing && testing === c.id}<LoaderCircle class="animate-spin" />{:else}<Send />{/if}Test
					</button>
					<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Remove" aria-label="Remove channel" onclick={() => channels.splice(i, 1)}><Trash2 /></button>
				</div>
				{#if c.kind === 'ntfy'}
					<div class="grid grid-cols-3 gap-2">
						<label><span class="label">Server</span><input class="input h-8 text-xs" placeholder="https://ntfy.sh" bind:value={c.config.server} /></label>
						<label><span class="label">Topic</span><input class="input h-8 text-xs" placeholder="my-printers" bind:value={c.config.topic} /></label>
						<label><span class="label">Access token</span><input class="input h-8 text-xs" type="password" autocomplete="off" placeholder={c.secrets.token ?? 'optional'} bind:value={c.input.token} /></label>
					</div>
				{:else}
					<div class="grid {c.kind === 'webhook' ? 'grid-cols-[2fr_1fr]' : ''} gap-2">
						<label><span class="label">{c.kind === 'discord' ? 'Discord webhook URL' : 'URL (receives a JSON POST)'}</span><input class="input h-8 text-xs" type="password" autocomplete="off" placeholder={c.secrets.url ?? 'https://…'} bind:value={c.input.url} /></label>
						{#if c.kind === 'webhook'}
							<label><span class="label">Authorization header</span><input class="input h-8 text-xs" type="password" autocomplete="off" placeholder={c.secrets.authorization ?? 'optional'} bind:value={c.input.authorization} /></label>
						{/if}
					</div>
				{/if}
				<div class="flex flex-wrap items-center gap-1.5 text-xs">
					<span class="mr-1 text-muted-foreground">When a print</span>
					{#each RESULTS as r (r.value)}
						<button type="button" class="badge h-6 cursor-pointer px-2 {c.on.includes(r.value) ? 'badge-primary' : ''}" aria-pressed={c.on.includes(r.value)} onclick={() => toggle(c, r.value)}>{r.label}</button>
					{/each}
					{#if c.lastError}<span class="ml-auto truncate text-danger" title={c.lastError}>Last attempt failed: {c.lastError}</span>{:else if c.lastSentAt}<span class="ml-auto text-muted-foreground">Last sent {ago(c.lastSentAt)}</span>{/if}
				</div>
			</div>
		{:else}
			{#if !loading}
				<div class="rounded-xl border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
					<BellRing class="mx-auto mb-2 size-5" />No channels yet. Add one to hear about finished and failed prints.
				</div>
			{/if}
		{/each}
		<button class="btn btn-secondary btn-sm" onclick={add}><Plus />Add channel</button>
	</div>
	{#snippet footer()}
		<button class="btn btn-ghost btn-sm" onclick={() => (open = false)}>Close</button>
		<button class="btn btn-primary btn-sm" disabled={saving} onclick={async () => (await save()) && (open = false)}>{#if saving}<LoaderCircle class="animate-spin" />{/if}Save</button>
	{/snippet}
</Dialog>
