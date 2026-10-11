<script lang="ts">
	import { onMount } from 'svelte';
	import { Ban, CircleAlert, Copy, KeyRound, LoaderCircle, Plus, Trash2, X } from '@lucide/svelte';
	import Switch from './Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { confirmAction, printers, toast } from '#lib/client/state.svelte.ts';
	import { listSources } from '#lib/client/library.ts';
	import { parseTags, type UploadTarget } from '#lib/queue.ts';
	import type { LibrarySourceSummary } from '#lib/library.ts';

	/** `status`: dashboard tokens; `upload`: slicer upload keys (OctoPrint-compatible API). */
	let { scope = 'status' }: { scope?: 'status' | 'upload' } = $props();

	type Token = {
		id: string;
		name: string;
		prefix: string;
		scope: 'status' | 'upload';
		includeAddresses: boolean;
		options: { upload?: UploadTarget; bedClear?: boolean };
		destination?: string;
		problem?: string | null;
		expiresAt: string | null;
		createdBy: string | null;
		createdAt: string;
		lastUsedAt: string | null;
		revokedAt: string | null;
	};

	let tokens = $state<Token[]>([]);
	let loaded = $state(false);
	let form = $state({ name: '', expiresInDays: '', includeAddresses: false, bedClear: false });
	/** Upload keys: where files go. */
	let dest = $state<{ kind: UploadTarget['kind']; sourceId: string; folder: string; printerId: string; tags: string; allowPrint: boolean }>({ kind: 'queue', sourceId: '', folder: '', printerId: '', tags: '', allowPrint: false });
	let sources = $state<LibrarySourceSummary[]>([]);
	const writable = $derived(sources.filter((x) => x.writable));
	onMount(() => {
		if (scope === 'upload') listSources().then((l) => (sources = l), () => {});
	});
	function uploadTarget(): UploadTarget {
		if (dest.kind === 'library') return { kind: 'library', sourceId: dest.sourceId || writable[0]?.id || '', folder: dest.folder };
		if (dest.kind === 'printer') return { kind: 'printer', printerId: dest.printerId || printers.list[0]?.id || '', allowPrint: dest.allowPrint };
		return { kind: 'queue', printerId: dest.printerId || null, tags: dest.printerId ? [] : parseTags(dest.tags) };
	}
	let busy = $state(false);
	/** The token just created: shown once, then gone for good. */
	let created = $state<{ token: string; record: Token } | null>(null);

	const origin = typeof location === 'undefined' ? '' : location.origin;

	async function load() {
		try {
			tokens = (await api.get<Token[]>('/api/integrations/tokens')).filter((t) => (t.scope ?? 'status') === scope);
		} catch (err) {
			toast('error', 'Could not load API tokens', errorMessage(err));
		} finally {
			loaded = true;
		}
	}
	onMount(load);

	async function create(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			created = await api.post<{ token: string; record: Token }>('/api/integrations/tokens', {
				name: form.name,
				expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null,
				...(scope === 'upload' ? { scope: 'upload', upload: uploadTarget() } : { includeAddresses: form.includeAddresses, bedClear: form.bedClear })
			});
			form = { name: '', expiresInDays: '', includeAddresses: false, bedClear: false };
			await load();
		} catch (err) {
			toast('error', 'Could not create the token', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function revoke(t: Token) {
		const ok = await confirmAction({
			title: `Revoke “${t.name}”?`,
			body: 'Dashboards using it stop getting status right away. This can’t be undone.',
			confirmLabel: 'Revoke',
			danger: true
		});
		if (!ok) return;
		try {
			await api.del(`/api/integrations/tokens/${t.id}`);
			if (created?.record.id === t.id) created = null;
			await load();
		} catch (err) {
			toast('error', 'Could not revoke', errorMessage(err));
		}
	}

	async function purge(t: Token) {
		try {
			await api.del(`/api/integrations/tokens/${t.id}?purge=1`);
			await load();
		} catch (err) {
			toast('error', 'Could not remove', errorMessage(err));
		}
	}

	function copy(text: string, what = 'Copied') {
		navigator.clipboard.writeText(text);
		toast('success', what);
	}

	const expired = (t: Token) => !!t.expiresAt && Date.parse(t.expiresAt) <= Date.now();
	const slicerUrl = `${origin}/octoprint`;
	const curl = $derived(
		!created ? '' : scope === 'upload' ? `curl -H "X-Api-Key: ${created.token}" ${slicerUrl}/api/version` : `curl -H "Authorization: Bearer ${created.token}" ${origin}/api/status`
	);
</script>

{#if created}
	<div class="mt-4 rounded-lg border border-success/30 bg-success/5 p-3">
		<div class="flex items-start gap-2">
			<KeyRound class="mt-0.5 size-4 shrink-0 text-success" />
			<div class="min-w-0 flex-1">
				<p class="text-[13px] font-medium">Token “{created.record.name}” created — copy it now</p>
				<p class="text-[11px] text-muted-foreground">Only a hash is stored, so it can't be shown again. Treat it like a password.</p>
			</div>
			<button class="btn btn-ghost btn-icon btn-sm -mt-1 -mr-1" aria-label="Dismiss" onclick={() => (created = null)}><X /></button>
		</div>
		<div class="mt-2 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5">
			<code class="min-w-0 flex-1 font-mono text-xs break-all select-all">{created.token}</code>
			<button class="btn btn-secondary btn-sm" onclick={() => copy(created!.token, 'Token copied')}><Copy />Copy</button>
		</div>
		{#if scope === 'upload'}
			<div class="mt-2 grid gap-1 text-[12px] sm:grid-cols-[8rem_1fr]">
				<span class="text-muted-foreground">Host / URL</span>
				<span class="flex min-w-0 items-center gap-2"><code class="min-w-0 truncate font-mono">{slicerUrl}</code><button class="btn btn-ghost btn-sm" onclick={() => copy(slicerUrl, 'URL copied')}><Copy />Copy</button></span>
				<span class="text-muted-foreground">Host type</span><span>OctoPrint</span>
				<span class="text-muted-foreground">API key</span><span>the key above (Cura: without <code class="font-mono">ocm_</code> if it refuses the underscore)</span>
			</div>
		{/if}
		<div class="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
			<code class="min-w-0 flex-1 truncate font-mono">{curl}</code>
			<button class="btn btn-ghost btn-sm" onclick={() => copy(curl, 'Command copied')}><Copy />curl</button>
		</div>
	</div>
{/if}

{#if tokens.length}
	<div class="mt-4 overflow-hidden rounded-lg border border-border">
		<table class="w-full text-xs">
			<thead class="bg-surface text-left text-[11px] text-muted-foreground">
				<tr>
					<th class="px-3 py-2 font-medium">Name</th>
					<th class="px-3 py-2 font-medium max-sm:hidden">Token</th>
					<th class="px-3 py-2 font-medium max-sm:hidden">Last used</th>
					<th class="px-3 py-2 font-medium max-sm:hidden">Expires</th>
					<th class="w-24 px-3 py-2"></th>
				</tr>
			</thead>
			<tbody>
				{#each tokens as t (t.id)}
					{@const dead = !!t.revokedAt || expired(t)}
					<tr class="border-t border-border {dead ? 'text-muted-foreground' : ''}">
						<td class="px-3 py-2">
							<span class="font-medium {dead ? 'line-through' : ''}">{t.name}</span>
							{#if t.includeAddresses}<span class="badge badge-warning ml-1.5">addresses</span>{/if}
							{#if t.options?.bedClear}<span class="badge ml-1.5">bed clear</span>{/if}
							{#if t.destination}<p class="text-[11px] text-muted-foreground">→ {t.destination}</p>{/if}
							{#if t.problem}<p class="text-[11px] text-danger">{t.problem}</p>{/if}
							{#if t.revokedAt}<span class="badge ml-1.5">revoked</span>{:else if expired(t)}<span class="badge ml-1.5">expired</span>{/if}
							<p class="text-[11px] text-muted-foreground">created {ago(t.createdAt)}{t.createdBy ? ` by ${t.createdBy}` : ''}<span class="sm:hidden"> · {t.prefix}… · used {t.lastUsedAt ? ago(t.lastUsedAt) : 'never'}</span></p>
						</td>
						<td class="px-3 py-2 font-mono text-muted-foreground max-sm:hidden">{t.prefix}…</td>
						<td class="px-3 py-2 text-muted-foreground max-sm:hidden">{t.lastUsedAt ? ago(t.lastUsedAt) : 'never'}</td>
						<td class="px-3 py-2 text-muted-foreground max-sm:hidden">{t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : 'never'}</td>
						<td class="px-3 py-2 text-right">
							{#if !t.revokedAt}
								<button class="btn btn-ghost btn-sm hover:text-danger" onclick={() => revoke(t)}><Ban />Revoke</button>
							{:else}
								<button class="btn btn-ghost btn-icon btn-sm" title="Remove from the list" onclick={() => purge(t)}><Trash2 /></button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if loaded}
	<p class="mt-4 text-xs text-muted-foreground">No tokens yet.</p>
{/if}

<form class="mt-4 grid items-end gap-2 md:grid-cols-[1fr_9rem_auto_auto]" onsubmit={create}>
	<div>
		<label class="label" for="tok-name-{scope}">Name</label>
		<input id="tok-name-{scope}" class="input h-8 text-xs touch:h-11" placeholder={scope === 'upload' ? 'OrcaSlicer on the workshop PC' : 'Homepage dashboard'} maxlength="80" required bind:value={form.name} />
	</div>
	<div>
		<label class="label" for="tok-exp-{scope}">Expires</label>
		<select id="tok-exp-{scope}" class="input h-8 text-xs touch:h-11" bind:value={form.expiresInDays}>
			<option value="">Never</option>
			<option value="30">In 30 days</option>
			<option value="90">In 90 days</option>
			<option value="365">In a year</option>
		</select>
	</div>
	{#if scope === 'status'}
		<div class="flex flex-wrap gap-x-4 gap-y-2">
			<label class="flex h-8 items-center gap-2 text-xs text-muted-foreground" title="Adds each printer's OctoPrint URL to its item. Off by default.">
				<Switch label="Include addresses" bind:checked={form.includeAddresses} />Include addresses
			</label>
			<label class="flex h-8 items-center gap-2 text-xs text-muted-foreground" title="Also allows POST /api/status/<printer id>/bed-clear (for a button or automation next to the printer).">
				<Switch label="May confirm bed clear" bind:checked={form.bedClear} />May confirm bed clear
			</label>
		</div>
	{:else}
		<div>
			<label class="label" for="tok-dest">Uploads go to</label>
			<select id="tok-dest" class="input h-8 text-xs touch:h-11" bind:value={dest.kind}>
				<option value="queue">The print queue</option>
				<option value="library" disabled={!writable.length}>A library folder{writable.length ? '' : ' (no writable source)'}</option>
				<option value="printer">A printer</option>
			</select>
		</div>
	{/if}
	<button class="btn btn-primary h-8 touch:h-11" disabled={busy || !form.name.trim()}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<Plus />{/if}Create token</button>
</form>
{#if scope === 'upload'}
	<div class="mt-2 grid gap-2 sm:grid-cols-3" data-testid="upload-destination">
		{#if dest.kind === 'library'}
			<label><span class="label">Source</span><select class="input h-8 text-xs touch:h-11" bind:value={dest.sourceId}>{#each writable as x (x.id)}<option value={x.id}>{x.name}</option>{/each}</select></label>
			<label><span class="label">Folder</span><input class="input h-8 font-mono text-xs touch:h-11" placeholder="(top level), e.g. slicer" bind:value={dest.folder} /></label>
		{:else if dest.kind === 'queue'}
			<label
				><span class="label">Printer</span><select class="input h-8 text-xs touch:h-11" bind:value={dest.printerId}
					><option value="">Any compatible printer</option>{#each printers.list as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select
				></label
			>
			<label><span class="label">Required tags</span><input class="input h-8 font-mono text-xs touch:h-11" placeholder="e.g. 0.4mm, petg" disabled={!!dest.printerId} bind:value={dest.tags} /></label>
		{:else}
			<label><span class="label">Printer</span><select class="input h-8 text-xs touch:h-11" bind:value={dest.printerId}>{#each printers.list as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select></label>
			<label class="flex items-end gap-2 pb-1.5 text-xs text-muted-foreground"><Switch label="May start prints" bind:checked={dest.allowPrint} />May start prints (“Upload and print”)</label>
		{/if}
	</div>
{/if}
{#if scope === 'upload'}
	<p class="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
		<CircleAlert class="mt-px size-3.5 shrink-0" />
		<span>
			In the slicer, add a physical printer / print host of type <b>OctoPrint</b> with the URL <code class="font-mono">{slicerUrl}</code> and the key as its API key. The key only opens
			<code class="font-mono">/octoprint/api/…</code> (version, upload) — nothing else in octo·modern.
		</span>
	</p>
{:else}
<p class="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
	<CircleAlert class="mt-px size-3.5 shrink-0" />
	<span>
		Send it as <code class="font-mono">Authorization: Bearer ocm_…</code>. Widgets that can't set headers may use <code class="font-mono">?token=ocm_…</code>, but
		URLs end up in proxy logs and browser history — prefer the header, and give such widgets their own token so you can revoke it alone. Badges:
		<code class="font-mono">/api/status/badge/&lt;printer id&gt;.svg?token=…</code>. Bed clear (tokens that may):
		<code class="font-mono">POST /api/status/&lt;printer id&gt;/bed-clear</code>
	</span>
</p>
{/if}
