<script lang="ts">
	import { tick } from 'svelte';
	import { ArrowLeft, CircleAlert, CircleCheck, LoaderCircle, Lock, Moon, Save, Send } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import Switch from '../Switch.svelte';
	import ChannelIcon from './ChannelIcon.svelte';
	import { errorMessage } from '#lib/client/api.ts';
	import { DAYS, notifyApi } from '#lib/client/notify.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { CHANNEL_TYPE_MAP, CHANNEL_TYPES, DEFAULT_QUIET, type ChannelInfo, type ChannelType, type QuietHours } from '#lib/notify.ts';

	/** Adds or edits one channel: type picker, the type's form, quiet hours, Send test. */
	let {
		open = $bindable(false),
		channel = null,
		mediaLinks = false,
		onsaved
	}: { open: boolean; channel: ChannelInfo | null; mediaLinks?: boolean; onsaved: (c: ChannelInfo) => void } = $props();

	let type = $state<ChannelType | null>(null);
	let name = $state('');
	let enabled = $state(true);
	let config = $state<Record<string, string>>({});
	let secrets = $state<Record<string, string>>({});
	/** Secret fields being (re)typed; stored ones show "Stored securely — change". */
	let changing = $state<Record<string, boolean>>({});
	let quiet = $state<QuietHours>({ ...DEFAULT_QUIET });
	let saving = $state(false);
	let testing = $state(false);
	let result = $state<{ ok: true; ms: number; image: boolean } | { ok: false; message: string } | null>(null);

	const info = $derived(type ? CHANNEL_TYPE_MAP[type] : null);

	function reset(c: ChannelInfo | null) {
		result = null;
		type = c?.type ?? null;
		name = c?.name ?? '';
		enabled = c?.enabled ?? true;
		config = { ...(c?.config ?? {}) };
		secrets = {};
		changing = {};
		quiet = { ...DEFAULT_QUIET, ...(c?.quiet ?? {}), days: [...(c?.quiet?.days ?? [])] };
		if (c) for (const f of CHANNEL_TYPE_MAP[c.type].fields) if (f.kind === 'secret') changing[f.key] = !c.secrets[f.key];
	}

	let lastOpen = false;
	$effect(() => {
		if (open && !lastOpen) reset(channel);
		lastOpen = open;
	});

	function pick(t: ChannelType) {
		type = t;
		result = null;
		const defaults: Record<string, string> = {};
		for (const f of CHANNEL_TYPE_MAP[t].fields) if (f.default && f.kind !== 'secret') defaults[f.key] = f.default;
		config = defaults;
		changing = Object.fromEntries(CHANNEL_TYPE_MAP[t].fields.filter((f) => f.kind === 'secret').map((f) => [f.key, true]));
		if (!name) name = CHANNEL_TYPE_MAP[t].label;
	}

	function body() {
		const s: Record<string, string> = {};
		for (const [k, v] of Object.entries(secrets)) if (changing[k] && v) s[k] = v;
		return { type, name, enabled, config, secrets: s, quiet };
	}

	async function test() {
		testing = true;
		result = null;
		try {
			result = await notifyApi.test(channel?.id ?? null, body());
		} catch (err) {
			result = { ok: false, message: errorMessage(err) };
		} finally {
			testing = false;
		}
		await tick();
		document.querySelector('[data-testid=channel-test]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		try {
			const r = channel ? await notifyApi.update(channel.id, body()) : await notifyApi.create(body());
			toast('success', channel ? 'Channel saved' : 'Channel added', r.channel.name);
			onsaved(r.channel);
			open = false;
		} catch (err) {
			toast('error', 'Could not save the channel', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	function toggleDay(d: number) {
		quiet.days = quiet.days.includes(d) ? quiet.days.filter((x) => x !== d) : [...quiet.days, d].sort();
	}
</script>

<Dialog
	bind:open
	title={channel ? `Edit ${channel.name}` : info ? `Add ${info.label}` : 'Add a channel'}
	description={info ? info.blurb : 'Where should notifications go?'}
	width="max-w-2xl"
>
	{#if !type}
		<div class="grid gap-2 sm:grid-cols-2" role="list" aria-label="Channel types">
			{#each CHANNEL_TYPES as t (t.type)}
				<button type="button" role="listitem" class="flex min-h-14 items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40" onclick={() => pick(t.type)} data-type={t.type}>
					<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><ChannelIcon type={t.type} /></span>
					<span class="min-w-0">
						<span class="block text-[13px] font-medium">{t.label}</span>
						<span class="block text-xs text-muted-foreground">{t.blurb}</span>
					</span>
				</button>
			{/each}
		</div>
	{:else if info}
		<form id="channel-form" class="space-y-4" onsubmit={save}>
			<div class="grid gap-3 sm:grid-cols-[1fr_auto]">
				<div>
					<label class="label" for="ch-name">Name</label>
					<input id="ch-name" class="input" placeholder="e.g. My phone" bind:value={name} />
				</div>
				<label class="flex items-center gap-2 self-end pb-2 text-[13px]"><Switch label="Enabled" bind:checked={enabled} />Enabled</label>
			</div>

			<div class="grid gap-3 sm:grid-cols-2">
				{#each info.fields as f (f.key)}
					<div class={f.half ? '' : 'sm:col-span-2'}>
						{#if f.kind === 'toggle'}
							<label class="flex min-h-9 items-center gap-2 text-[13px]">
								<Switch label={f.label} checked={config[f.key] === 'true'} onchange={(v) => (config[f.key] = v ? 'true' : '')} />{f.label}
							</label>
						{:else}
							<label class="label" for="ch-{f.key}">{f.label}{f.required ? '' : ' (optional)'}</label>
							{#if f.kind === 'secret'}
								{#if changing[f.key]}
									<input id="ch-{f.key}" class="input font-mono text-xs" type="password" autocomplete="new-password" placeholder={f.placeholder} bind:value={secrets[f.key]} />
								{:else}
									<button type="button" class="btn btn-secondary h-9 w-full justify-start font-normal text-muted-foreground" onclick={() => (changing[f.key] = true)}>
										<Lock /><span class="truncate">Stored securely{channel?.secrets[f.key] && channel.secrets[f.key] !== '••••••' ? ` · ${channel.secrets[f.key]}` : ''} — change</span>
									</button>
								{/if}
							{:else if f.kind === 'select'}
								<select id="ch-{f.key}" class="input" bind:value={config[f.key]}>
									{#each f.options ?? [] as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
								</select>
							{:else}
								<input
									id="ch-{f.key}"
									class="input {f.kind === 'url' || f.kind === 'number' ? 'font-mono text-xs' : ''}"
									type={f.kind === 'number' ? 'text' : f.kind === 'email' ? 'email' : 'text'}
									inputmode={f.kind === 'number' ? 'numeric' : f.kind === 'url' ? 'url' : undefined}
									placeholder={f.placeholder}
									bind:value={config[f.key]}
								/>
							{/if}
							{#if f.help}<p class="mt-1 text-[11px] text-muted-foreground">{f.help}</p>{/if}
						{/if}
					</div>
				{/each}
			</div>

			{#if info.images === 'link'}
				<p class="rounded-lg bg-surface px-3 py-2 text-[11px] text-muted-foreground">
					{info.label} shows pictures by link only: {mediaLinks ? 'snapshots are shared by expiring link (General → Share snapshots by link).' : 'turn on “Share snapshots by link” under General to include the webcam snapshot.'}
				</p>
			{/if}

			<div class="space-y-3 rounded-lg border border-border p-3">
				<div class="flex items-center gap-3">
					<Moon class="size-4 text-muted-foreground" />
					<div class="flex-1">
						<p class="text-[13px] font-medium">Quiet hours</p>
						<p class="text-[11px] text-muted-foreground">Nothing is sent to this channel in this period (server time).</p>
					</div>
					<Switch label="Quiet hours" bind:checked={quiet.enabled} />
				</div>
				{#if quiet.enabled}
					<div class="flex flex-wrap items-end gap-3 border-t border-border pt-3">
						<label class="w-28"><span class="label">From</span><input class="input font-mono text-xs" type="time" bind:value={quiet.start} /></label>
						<label class="w-28"><span class="label">Until</span><input class="input font-mono text-xs" type="time" bind:value={quiet.end} /></label>
						<div>
							<span class="label">Starting on</span>
							<div class="flex flex-wrap gap-1">
								{#each DAYS as d, i (d)}
									<button type="button" class="badge h-8 min-w-10 cursor-pointer justify-center {quiet.days.includes(i) ? 'badge-primary' : ''}" aria-pressed={quiet.days.includes(i)} onclick={() => toggleDay(i)}>{d}</button>
								{/each}
							</div>
						</div>
					</div>
					<p class="text-[11px] text-muted-foreground">{quiet.days.length ? '' : 'No day picked: every day. '}A period past midnight belongs to the day it starts.</p>
					<label class="flex items-center gap-2 text-[13px]"><Switch label="Still send errors and failures" bind:checked={quiet.allowCritical} />Still send errors and failures</label>
				{/if}
			</div>

			{#if result}
				<div class="flex items-start gap-2 rounded-lg border p-3 text-xs {result.ok ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'}" data-testid="channel-test" role="status">
					{#if result.ok}
						<CircleCheck class="size-4 shrink-0 text-success" />
						<p class="font-medium">Delivered in {result.ms} ms{result.image ? ', with a test picture' : ''}. Check {info.label}.</p>
					{:else}
						<CircleAlert class="size-4 shrink-0 text-danger" />
						<div class="min-w-0">
							<p class="font-medium">The test didn’t go through</p>
							<p class="mt-0.5 font-mono break-words text-muted-foreground" data-testid="channel-test-error">{result.message}</p>
						</div>
					{/if}
				</div>
			{/if}
		</form>
	{/if}
	{#snippet footer()}
		{#if type}
			{#if !channel}
				<button type="button" class="btn btn-ghost btn-icon mr-1" title="Choose another type" aria-label="Choose another type" onclick={() => ((type = null), (result = null))}><ArrowLeft /></button>
			{/if}
			<button type="button" class="btn btn-secondary mr-auto" disabled={testing} onclick={test}>
				{#if testing}<LoaderCircle class="animate-spin" />{:else}<Send />{/if}Send test
			</button>
			<button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
			<button form="channel-form" class="btn btn-primary" disabled={saving}><Save />{channel ? 'Save' : 'Add channel'}</button>
		{:else}
			<button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
		{/if}
	{/snippet}
</Dialog>
