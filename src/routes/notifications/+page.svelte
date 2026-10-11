<script lang="ts">
	import { onMount } from 'svelte';
	import { BellRing, CircleAlert, Eraser, LoaderCircle, Moon, Pencil, Plus, RefreshCw, Route, Save, Send, Settings2, Trash2, Image as ImageIcon } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import ActionMenu from '#lib/components/ActionMenu.svelte';
	import ChannelDialog from '#lib/components/notify/ChannelDialog.svelte';
	import ChannelIcon from '#lib/components/notify/ChannelIcon.svelte';
	import RuleDialog from '#lib/components/notify/RuleDialog.svelte';
	import PushDevices from '#lib/components/notify/PushDevices.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { DAYS, notifyApi, type NotifySettings } from '#lib/client/notify.ts';
	import { confirmAction, printers, toast } from '#lib/client/state.svelte.ts';
	import { listLayout } from '#lib/client/viewport.svelte.ts';
	import { CHANNEL_TYPE_MAP, EVENT_INFO, type ChannelInfo, type Delivery, type DeliveryStatus, type Rule } from '#lib/notify.ts';

	let data = $state<NotifySettings | null>(null);
	let log = $state<Delivery[] | null>(null);
	let channelOpen = $state(false);
	let editing = $state<ChannelInfo | null>(null);
	let ruleOpen = $state(false);
	let editingRule = $state<Rule | null>(null);
	let testing = $state<string | null>(null);
	let savingOptions = $state(false);

	/** The options form (strings for the number lists). */
	let opts = $state({ publicUrl: '', mediaLinks: false, dedupeMinutes: 10, ratePer10Min: 20, percents: '', minutesLeft: '', hotMinutes: 15, bedC: 40, hotendC: 50, offlineGraceS: 120 });

	function fill(d: NotifySettings) {
		data = { ...data, ...d };
		const g = d.general;
		opts = {
			publicUrl: g.publicUrl ?? '',
			mediaLinks: g.mediaLinks,
			dedupeMinutes: g.dedupeMinutes,
			ratePer10Min: g.ratePer10Min,
			percents: g.progressPercents.join(', '),
			minutesLeft: g.progressMinutesLeft.join(', '),
			hotMinutes: g.hot.minutes,
			bedC: g.hot.bedC,
			hotendC: g.hot.hotendC,
			offlineGraceS: g.offlineGraceS
		};
	}

	async function load() {
		try {
			fill(await notifyApi.load());
		} catch (err) {
			toast('error', 'Could not load the notification settings', errorMessage(err));
		}
	}

	async function loadLog() {
		try {
			log = (await notifyApi.log(100)).items;
		} catch (err) {
			toast('error', 'Could not load the delivery log', errorMessage(err));
		}
	}

	onMount(() => {
		void load();
		void loadLog();
	});

	function addChannel() {
		editing = null;
		channelOpen = true;
	}

	function editChannel(c: ChannelInfo) {
		editing = c;
		channelOpen = true;
	}

	async function saved() {
		await load();
		await loadLog();
	}

	async function test(c: ChannelInfo) {
		testing = c.id;
		try {
			const r = await notifyApi.test(c.id);
			toast('success', `Test sent to ${c.name}`, `Delivered in ${r.ms} ms.`);
		} catch (err) {
			toast('error', `The test to ${c.name} didn’t go through`, errorMessage(err));
		} finally {
			testing = null;
			await load();
			await loadLog();
		}
	}

	async function toggleChannel(c: ChannelInfo, enabled: boolean) {
		try {
			await notifyApi.update(c.id, { type: c.type, name: c.name, enabled, config: c.config, secrets: {}, quiet: c.quiet });
			await load();
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		}
	}

	async function removeChannel(c: ChannelInfo) {
		const used = (data?.rules ?? []).filter((r) => r.channels.includes(c.id));
		const ok = await confirmAction({
			title: `Remove ${c.name}?`,
			body: `octo·modern forgets this channel and its stored tokens.${used.length ? ` It’s also removed from ${used.length === 1 ? 'the rule' : 'the rules'} ${used.map((r) => `“${r.name}”`).join(', ')}.` : ''}`,
			confirmLabel: 'Remove',
			danger: true
		});
		if (!ok) return;
		try {
			await api.del(`/api/settings/notifications/channels/${encodeURIComponent(c.id)}?confirm=1`);
			toast('success', 'Channel removed', c.name);
			await load();
		} catch (err) {
			toast('error', 'Could not remove', errorMessage(err));
		}
	}

	async function saveRules(rules: Rule[]): Promise<boolean> {
		try {
			fill(await notifyApi.save({ rules }));
			return true;
		} catch (err) {
			toast('error', 'Could not save the rules', errorMessage(err));
			return false;
		}
	}

	async function saveRule(r: Rule): Promise<boolean> {
		const rules = data?.rules ?? [];
		const next = r.id && rules.some((x) => x.id === r.id) ? rules.map((x) => (x.id === r.id ? r : x)) : [...rules, r];
		const ok = await saveRules(next);
		if (ok) toast('success', 'Rule saved', r.name || undefined);
		return ok;
	}

	async function removeRule(r: Rule) {
		const ok = await confirmAction({ title: `Remove the rule “${r.name}”?`, body: 'Its events stop going to its channels (unless another rule sends them).', confirmLabel: 'Remove', danger: true });
		if (ok && (await saveRules((data?.rules ?? []).filter((x) => x.id !== r.id)))) toast('success', 'Rule removed');
	}

	async function saveOptions(e: SubmitEvent) {
		e.preventDefault();
		savingOptions = true;
		try {
			fill(
				await notifyApi.save({
					publicUrl: opts.publicUrl,
					mediaLinks: opts.mediaLinks,
					dedupeMinutes: Number(opts.dedupeMinutes),
					ratePer10Min: Number(opts.ratePer10Min),
					progressPercents: opts.percents as unknown as number[],
					progressMinutesLeft: opts.minutesLeft as unknown as number[],
					hot: { minutes: Number(opts.hotMinutes), bedC: Number(opts.bedC), hotendC: Number(opts.hotendC) },
					offlineGraceS: Number(opts.offlineGraceS)
				})
			);
			toast('success', 'Notification options saved');
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		} finally {
			savingOptions = false;
		}
	}

	async function clearLog() {
		if (!(await confirmAction({ title: 'Clear the delivery log?', body: 'Removes the record of past deliveries. Channels and rules stay.', confirmLabel: 'Clear', danger: true }))) return;
		try {
			await notifyApi.clearLog();
			await loadLog();
		} catch (err) {
			toast('error', 'Could not clear the log', errorMessage(err));
		}
	}

	const channelName = (id: string) => data?.channels.find((c) => c.id === id)?.name ?? '?';
	const printerName = (id: string) => printers.list.find((p) => p.id === id)?.name ?? 'removed printer';
	const quietText = (c: ChannelInfo) =>
		c.quiet.enabled ? `Quiet ${c.quiet.start}–${c.quiet.end}${c.quiet.days.length ? ` (${c.quiet.days.map((d) => DAYS[d]).join(' ')})` : ''}${c.quiet.allowCritical ? ', errors still sent' : ''}` : null;
	const kindLabel = (k: string) => (k in EVENT_INFO ? EVENT_INFO[k as keyof typeof EVENT_INFO].label : k);
	const STATUS: Record<DeliveryStatus, { label: string; cls: string }> = {
		sent: { label: 'sent', cls: 'badge-success' },
		failed: { label: 'failed', cls: 'badge-danger' },
		quiet: { label: 'quiet hours', cls: '' },
		deduped: { label: 'duplicate', cls: '' },
		rate_limited: { label: 'rate limited', cls: 'badge-warning' }
	};
	const effectiveUrl = $derived(opts.publicUrl || data?.envOrigin || '');
</script>

<svelte:head><title>Notifications · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Notifications" description="Where octo·modern tells you about prints and printers, and when.">
		{#snippet actions()}
			<button class="btn btn-primary" onclick={addChannel}><Plus />Add channel</button>
		{/snippet}
	</PageHeader>

	<div class="max-w-5xl space-y-5 page-x pb-12">
		{#if !data}
			<div class="grid h-32 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
		{:else}
			<!-- Channels -->
			<section class="space-y-2" aria-labelledby="channels-h">
				<h2 id="channels-h" class="flex items-center gap-2 text-sm font-semibold"><BellRing class="size-4 text-primary" />Channels</h2>
				{#each data.channels as c (c.id)}
					{@const t = CHANNEL_TYPE_MAP[c.type]}
					<div class="card flex items-center gap-3 px-4 py-3 sm:gap-4 sm:px-5" data-channel={c.name}>
						<span class="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary {c.enabled ? '' : 'opacity-50'}"><ChannelIcon type={c.type} class="size-5" /></span>
						<div class="min-w-0 flex-1">
							<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
								<span class="truncate">{c.name}</span>
								<span class="badge">{t.label}</span>
								{#if !c.enabled}<span class="badge">off</span>{/if}
							</p>
							<p class="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
								{#if c.lastError}
									<span class="flex min-w-0 items-center gap-1 text-danger" title={c.lastError}><CircleAlert class="size-3.5 shrink-0" /><span class="truncate">{c.lastError}</span></span>
								{:else if c.lastSentAt}
									<span>Last sent {ago(c.lastSentAt)}</span>
								{:else}
									<span>Nothing sent yet</span>
								{/if}
								{#if quietText(c)}<span class="flex items-center gap-1"><Moon class="size-3" />{quietText(c)}</span>{/if}
							</p>
						</div>
						{#if listLayout.current}
							<ActionMenu
								title={c.name}
								description={t.label}
								actions={[
									{ label: 'Send test', icon: Send, disabled: !!testing, onclick: () => test(c) },
									{ label: 'Edit', icon: Pencil, onclick: () => editChannel(c) },
									{ label: c.enabled ? 'Turn off' : 'Turn on', icon: BellRing, onclick: () => toggleChannel(c, !c.enabled) },
									{ label: 'Remove', icon: Trash2, danger: true, onclick: () => removeChannel(c) }
								]}
							/>
						{:else}
							<Switch label="Enabled" checked={c.enabled} onchange={(v) => toggleChannel(c, v)} />
							<button class="btn btn-secondary btn-sm" disabled={!!testing} onclick={() => test(c)}>
								{#if testing === c.id}<LoaderCircle class="animate-spin" />{:else}<Send />{/if}Send test
							</button>
							<button class="btn btn-secondary btn-sm" onclick={() => editChannel(c)}><Pencil />Edit</button>
							<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Remove {c.name}" aria-label="Remove {c.name}" onclick={() => removeChannel(c)}><Trash2 /></button>
						{/if}
					</div>
				{:else}
					<div class="card flex flex-col items-center gap-3 px-6 py-10 text-center">
						<span class="grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><BellRing class="size-5" /></span>
						<p class="max-w-sm text-[0.8125rem] text-muted-foreground">No channels yet. Add browser push, ntfy, Discord, Slack, Telegram, Pushover, Gotify, Matrix, email, Home Assistant or a webhook.</p>
						<button class="btn btn-primary" onclick={addChannel}><Plus />Add channel</button>
					</div>
				{/each}
			</section>

			<!-- Browser push on this device (the signed-in admin's own devices). -->
			<PushDevices admin />

			<!-- Rules -->
			<section class="card p-4 sm:p-5" aria-labelledby="rules-h">
				<div class="flex items-center gap-2">
					<h2 id="rules-h" class="flex flex-1 items-center gap-2 text-sm font-semibold"><Route class="size-4 text-primary" />Rules</h2>
					<button class="btn btn-secondary btn-sm" disabled={!data.channels.length} onclick={() => ((editingRule = null), (ruleOpen = true))}><Plus />Add rule</button>
				</div>
				<p class="mt-1 text-xs text-muted-foreground">Each rule sends some events from some printers to some channels. A channel gets an event once, however many rules match.</p>
				<ul class="mt-3 divide-y divide-border rounded-xl border border-border">
					{#each data.rules as r (r.id)}
						<li class="flex items-start gap-3 px-3 py-3 sm:px-4 {r.enabled ? '' : 'opacity-60'}" data-rule={r.name}>
							<div class="min-w-0 flex-1 space-y-1.5">
								<p class="text-[0.8125rem] font-medium">{r.name}{#if !r.enabled}<span class="badge ml-2">off</span>{/if}</p>
								<p class="text-xs text-muted-foreground">
									<span class="text-foreground">{r.printers === 'all' ? 'All printers' : r.printers.map(printerName).join(', ') || 'No printers'}</span>
									→ {r.channels.length ? r.channels.map(channelName).join(', ') : 'no channels'}
								</p>
								<div class="flex flex-wrap gap-1">
									{#each r.events as k (k)}<span class="badge {EVENT_INFO[k].severity === 'error' ? 'badge-danger' : EVENT_INFO[k].severity === 'success' ? 'badge-success' : EVENT_INFO[k].severity === 'warning' ? 'badge-warning' : ''}">{EVENT_INFO[k].label}</span>{:else}<span class="text-xs text-muted-foreground">No events</span>{/each}
								</div>
							</div>
							{#if listLayout.current}
								<ActionMenu
									title={r.name}
									actions={[
										{ label: 'Edit', icon: Pencil, onclick: () => ((editingRule = r), (ruleOpen = true)) },
										{ label: 'Remove', icon: Trash2, danger: true, onclick: () => removeRule(r) }
									]}
								/>
							{:else}
								<button class="btn btn-secondary btn-sm" onclick={() => ((editingRule = r), (ruleOpen = true))}><Pencil />Edit</button>
								<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Remove rule {r.name}" aria-label="Remove rule {r.name}" onclick={() => removeRule(r)}><Trash2 /></button>
							{/if}
						</li>
					{:else}
						<li class="px-4 py-6 text-center text-xs text-muted-foreground">{data.channels.length ? 'No rules: nothing is sent. Add one.' : 'Add a channel, then a rule.'}</li>
					{/each}
				</ul>
			</section>

			<!-- Options -->
			<form class="card p-4 sm:p-5" onsubmit={saveOptions} aria-labelledby="opts-h">
				<h2 id="opts-h" class="flex items-center gap-2 text-sm font-semibold"><Settings2 class="size-4 text-primary" />Options</h2>
				<div class="mt-4 grid gap-4 sm:grid-cols-2">
					<div class="sm:col-span-2">
						<label class="label" for="o-url">Public URL of octo·modern</label>
						<div class="flex flex-wrap gap-2">
							<input id="o-url" class="input min-w-0 flex-1 font-mono text-xs" inputmode="url" placeholder={data.envOrigin ?? data.seenUrl ?? 'https://octo.example.com'} bind:value={opts.publicUrl} />
							{#if data.seenUrl && opts.publicUrl !== data.seenUrl}<button type="button" class="btn btn-secondary btn-sm h-9" onclick={() => (opts.publicUrl = data!.seenUrl!)}>Use {data.seenUrl}</button>{/if}
						</div>
						<p class="mt-1 text-[0.6875rem] text-muted-foreground">
							For “Open in octo·modern” links.{data.envOrigin ? ` Empty: ORIGIN (${data.envOrigin}).` : ' Empty: no links.'}
						</p>
					</div>
					<label class="flex items-start gap-3 sm:col-span-2">
						<Switch label="Share snapshots by link" bind:checked={opts.mediaLinks} />
						<span class="text-[0.8125rem]">
							<span class="flex items-center gap-1.5 font-medium"><ImageIcon class="size-3.5 text-muted-foreground" />Share snapshots by link</span>
							<span class="block text-xs text-muted-foreground">Slack, Gotify and Home Assistant show pictures only by URL: each snapshot gets an unguessable link under the public URL, readable without signing in, for 48 hours.{!effectiveUrl ? ' Needs a public URL.' : ''}</span>
						</span>
					</label>
					<div>
						<label class="label" for="o-pct">Progress at (%)</label>
						<input id="o-pct" class="input font-mono text-xs" placeholder="25, 50, 75" bind:value={opts.percents} />
					</div>
					<div>
						<label class="label" for="o-left">And with minutes left</label>
						<input id="o-left" class="input font-mono text-xs" placeholder="10" bind:value={opts.minutesLeft} />
					</div>
					<div>
						<span class="label">Still hot after a print</span>
						<div class="grid grid-cols-3 gap-2">
							<label><span class="sr-only">Minutes after the print</span><input class="input font-mono text-xs" inputmode="decimal" aria-label="Minutes after the print" bind:value={opts.hotMinutes} /><span class="mt-0.5 block text-[0.6875rem] text-muted-foreground">min after</span></label>
							<label><span class="sr-only">Bed threshold</span><input class="input font-mono text-xs" inputmode="numeric" aria-label="Bed threshold °C" bind:value={opts.bedC} /><span class="mt-0.5 block text-[0.6875rem] text-muted-foreground">bed ≥ °C</span></label>
							<label><span class="sr-only">Hotend threshold</span><input class="input font-mono text-xs" inputmode="numeric" aria-label="Hotend threshold °C" bind:value={opts.hotendC} /><span class="mt-0.5 block text-[0.6875rem] text-muted-foreground">hotend ≥ °C</span></label>
						</div>
					</div>
					<div>
						<label class="label" for="o-grace">Offline after (seconds)</label>
						<input id="o-grace" class="input font-mono text-xs" inputmode="numeric" bind:value={opts.offlineGraceS} />
						<p class="mt-1 text-[0.6875rem] text-muted-foreground">A printer must stay unreachable or disconnected this long. “Back” is only sent after an offline or error message.</p>
					</div>
					<div>
						<label class="label" for="o-dedupe">Same event at most every (minutes)</label>
						<input id="o-dedupe" class="input font-mono text-xs" inputmode="numeric" bind:value={opts.dedupeMinutes} />
					</div>
					<div>
						<label class="label" for="o-rate">At most per channel per 10 minutes</label>
						<input id="o-rate" class="input font-mono text-xs" inputmode="numeric" bind:value={opts.ratePer10Min} />
					</div>
				</div>
				<div class="mt-4 flex justify-end">
					<button class="btn btn-primary" disabled={savingOptions}><Save />Save options</button>
				</div>
			</form>

			<!-- Delivery log -->
			<section class="card overflow-hidden" aria-labelledby="log-h">
				<div class="flex items-center gap-2 px-4 pt-4 sm:px-5">
					<h2 id="log-h" class="flex-1 text-sm font-semibold">Recent deliveries</h2>
					<button class="btn btn-ghost btn-icon btn-sm" title="Refresh" aria-label="Refresh the delivery log" onclick={loadLog}><RefreshCw /></button>
					<button class="btn btn-ghost btn-icon btn-sm" title="Clear" aria-label="Clear the delivery log" disabled={!log?.length} onclick={clearLog}><Eraser /></button>
				</div>
				<p class="px-4 pb-3 text-xs text-muted-foreground sm:px-5">The last 100 deliveries, including the ones quiet hours, de-duplication or the rate limit held back.</p>
				{#if !log}
					<div class="grid h-20 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
				{:else if !log.length}
					<p class="border-t border-border px-5 py-6 text-center text-xs text-muted-foreground">Nothing sent yet.</p>
				{:else if listLayout.current}
					<ul class="divide-y divide-border border-t border-border" data-testid="delivery-list">
						{#each log as d (d.id)}
							<li class="space-y-1 px-4 py-3">
								<div class="flex items-center gap-2">
									<span class="badge {STATUS[d.status].cls}">{STATUS[d.status].label}</span>
									<span class="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">{d.title}</span>
								</div>
								<p class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
									<ChannelIcon type={d.channelType} class="size-3" />{d.channelName} · {kindLabel(d.kind)} · {ago(d.at)}{#if d.image}<ImageIcon class="size-3" />{/if}
								</p>
								{#if d.error}<p class="font-mono text-[0.6875rem] break-words text-danger">{d.error}</p>{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<table class="w-full text-left text-[0.8125rem]" data-testid="delivery-table">
						<thead class="border-y border-border bg-surface text-[0.6875rem] text-muted-foreground">
							<tr>
								<th class="px-5 py-2 font-medium">When</th>
								<th class="px-3 py-2 font-medium">Channel</th>
								<th class="px-3 py-2 font-medium">Event</th>
								<th class="px-3 py-2 font-medium">Status</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-border">
							{#each log as d (d.id)}
								<tr class="align-top">
									<td class="px-5 py-2 text-xs whitespace-nowrap text-muted-foreground" title={new Date(d.at).toLocaleString()}>{ago(d.at)}</td>
									<td class="px-3 py-2 whitespace-nowrap"><span class="flex items-center gap-1.5"><ChannelIcon type={d.channelType} class="size-3.5 text-muted-foreground" />{d.channelName}</span></td>
									<td class="px-3 py-2">
										<p class="flex items-center gap-1.5">{d.title}{#if d.image}<ImageIcon class="size-3.5 shrink-0 text-muted-foreground" aria-label="with a picture" />{/if}</p>
										<p class="text-[0.6875rem] text-muted-foreground">{kindLabel(d.kind)}{d.printerName ? ` · ${d.printerName}` : ''}</p>
										{#if d.error}<p class="mt-0.5 font-mono text-[0.6875rem] break-words text-danger">{d.error}</p>{/if}
									</td>
									<td class="px-3 py-2 whitespace-nowrap"><span class="badge {STATUS[d.status].cls}">{STATUS[d.status].label}</span>{#if d.ms != null}<span class="ml-1.5 font-mono text-[0.6875rem] text-muted-foreground">{d.ms} ms</span>{/if}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</section>
		{/if}
	</div>
</div>

<ChannelDialog bind:open={channelOpen} channel={editing} mediaLinks={!!data?.general.mediaLinks && !!effectiveUrl} onsaved={saved} />
<RuleDialog bind:open={ruleOpen} rule={editingRule} channels={data?.channels ?? []} onsave={saveRule} />
