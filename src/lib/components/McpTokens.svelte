<script lang="ts">
	import { onMount } from 'svelte';
	import { Ban, Bot, CircleAlert, Copy, Eye, KeyRound, LoaderCircle, Plus, SlidersHorizontal, Trash2 } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import Segmented from './Segmented.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { confirmAction, printers, toast } from '#lib/client/state.svelte.ts';

	/** MCP tokens (Settings → Integrations): created here, shown once with setup snippets for Claude Code and Claude Desktop. */
	type Token = {
		id: string;
		name: string;
		prefix: string;
		scope: string;
		options: { mcp?: { access: 'read' | 'control'; printers: 'all' | string[] } };
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
	let open = $state(false);
	let busy = $state(false);
	let form = $state({ name: '', access: 'read' as 'read' | 'control', which: 'all' as 'all' | 'some', printers: [] as string[], expiresInDays: '' });
	/** The token just created: shown once, then gone for good. */
	let created = $state<{ token: string; record: Token } | null>(null);
	/** Which setup snippet is shown. */
	let client = $state<'code' | 'desktop' | 'other'>('code');

	const origin = typeof location === 'undefined' ? '' : location.origin;
	const url = `${origin}/mcp`;

	async function load() {
		try {
			tokens = (await api.get<Token[]>('/api/integrations/tokens')).filter((t) => t.scope === 'mcp');
		} catch (err) {
			toast('error', 'Could not load MCP tokens', errorMessage(err));
		} finally {
			loaded = true;
		}
	}
	onMount(load);

	function start() {
		form = { name: '', access: 'read', which: 'all', printers: [], expiresInDays: '' };
		created = null;
		client = 'code';
		open = true;
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			created = await api.post<{ token: string; record: Token }>('/api/integrations/tokens', {
				scope: 'mcp',
				name: form.name,
				access: form.access,
				printers: form.which === 'all' ? 'all' : form.printers,
				expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null
			});
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
			body: 'Assistants using it lose access right away. This can’t be undone.',
			confirmLabel: 'Revoke',
			danger: true
		});
		if (!ok) return;
		try {
			await api.del(`/api/integrations/tokens/${t.id}`);
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

	function togglePrinter(id: string, on: boolean) {
		form.printers = on ? [...form.printers, id] : form.printers.filter((x) => x !== id);
	}

	const expired = (t: Token) => !!t.expiresAt && Date.parse(t.expiresAt) <= Date.now();
	const canCreate = $derived(!!form.name.trim() && (form.which === 'all' || form.printers.length > 0));

	/** Setup snippets for the token just created. */
	const snippets = $derived.by(() => {
		const token = created?.token ?? 'ocx_…';
		const code = `claude mcp add --transport http octo-modern ${url} --header "Authorization: Bearer ${token}"`;
		// mcp-remote bridges Claude Desktop (stdio) to an HTTP server; the header goes through an
		// env var because Desktop on Windows mangles spaces in args. Plain http needs --allow-http.
		const args = ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}', ...(url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) ? ['--allow-http'] : [])];
		const desktop = JSON.stringify({ mcpServers: { 'octo-modern': { command: 'npx', args, env: { AUTH_HEADER: `Bearer ${token}` } } } }, null, 2);
		const other = `URL:       ${url}\nTransport: Streamable HTTP\nHeader:    Authorization: Bearer ${token}`;
		return { code, desktop, other };
	});
	const snippet = $derived(snippets[client]);
</script>

{#if tokens.length}
	<div class="mt-4 overflow-hidden rounded-lg border border-border" data-testid="mcp-tokens">
		<table class="w-full text-xs">
			<thead class="bg-surface text-left text-[0.6875rem] text-muted-foreground">
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
							{#if t.options.mcp?.access === 'control'}<span class="badge badge-warning ml-1.5">control</span>{:else}<span class="badge ml-1.5">read-only</span>{/if}
							{#if t.revokedAt}<span class="badge ml-1.5">revoked</span>{:else if expired(t)}<span class="badge ml-1.5">expired</span>{/if}
							{#if t.destination}<p class="text-[0.6875rem] text-muted-foreground">{t.destination}</p>{/if}
							{#if t.problem && !dead}<p class="text-[0.6875rem] text-danger">{t.problem}</p>{/if}
							<p class="text-[0.6875rem] text-muted-foreground">created {ago(t.createdAt)}{t.createdBy ? ` by ${t.createdBy}` : ''}<span class="sm:hidden"> · {t.prefix}… · used {t.lastUsedAt ? ago(t.lastUsedAt) : 'never'}</span></p>
						</td>
						<td class="px-3 py-2 font-mono text-muted-foreground max-sm:hidden">{t.prefix}…</td>
						<td class="px-3 py-2 text-muted-foreground max-sm:hidden">{t.lastUsedAt ? ago(t.lastUsedAt) : 'never'}</td>
						<td class="px-3 py-2 text-muted-foreground max-sm:hidden">{t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : 'never'}</td>
						<td class="px-3 py-2 text-right">
							{#if !t.revokedAt}
								<button class="btn btn-ghost btn-sm hover:text-danger touch:h-11" onclick={() => revoke(t)}><Ban />Revoke</button>
							{:else}
								<button class="btn btn-ghost btn-icon btn-sm touch:size-11" title="Remove from the list" aria-label="Remove from the list" onclick={() => purge(t)}><Trash2 /></button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if loaded}
	<p class="mt-4 text-xs text-muted-foreground">No MCP tokens yet.</p>
{/if}

<div class="mt-4 flex flex-wrap items-center gap-3">
	<button class="btn btn-primary touch:h-11" onclick={start} data-testid="mcp-new"><Plus />New MCP token</button>
	<span class="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
		Endpoint <code class="font-mono">{url}</code>
		<button class="btn btn-ghost btn-sm touch:h-11" onclick={() => copy(url, 'URL copied')}><Copy />Copy</button>
	</span>
</div>

<Dialog bind:open title={created ? `“${created.record.name}” is ready` : 'New MCP token'} description={created ? 'Copy the token now: only a hash is stored, so it can’t be shown again.' : 'For Claude Code, Claude Desktop and other MCP clients.'} width="max-w-xl">
	{#if !created}
		<form id="mcp-form" class="space-y-4" onsubmit={create}>
			<div class="grid gap-3 sm:grid-cols-[1fr_9rem]">
				<div>
					<label class="label" for="mcp-name">Name</label>
					<input id="mcp-name" class="input touch:h-11" placeholder="Claude Code on my laptop" maxlength="80" required bind:value={form.name} />
				</div>
				<div>
					<label class="label" for="mcp-exp">Expires</label>
					<select id="mcp-exp" class="input touch:h-11" bind:value={form.expiresInDays}>
						<option value="">Never</option>
						<option value="30">In 30 days</option>
						<option value="90">In 90 days</option>
						<option value="365">In a year</option>
					</select>
				</div>
			</div>
			<div>
				<span class="label">Access</span>
				<div class="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Access">
					{#each [{ id: 'read', icon: Eye, title: 'Read-only', body: 'Status, camera, files, queue, history, stats, maintenance.' }, { id: 'control', icon: SlidersHorizontal, title: 'Control', body: 'Also pause, resume, cancel, start, queue and heat. Cancel and start ask for confirmation.' }] as o (o.id)}
						{@const on = form.access === o.id}
						<button
							type="button"
							role="radio"
							aria-checked={on}
							class="flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors {on ? 'border-primary/60 bg-primary-soft' : 'border-border hover:bg-accent'}"
							onclick={() => (form.access = o.id as 'read' | 'control')}
						>
							<o.icon class="mt-0.5 size-4 shrink-0 {on ? 'text-primary' : 'text-muted-foreground'}" />
							<span><span class="block text-[0.8125rem] font-medium">{o.title}</span><span class="block text-[0.6875rem] text-muted-foreground">{o.body}</span></span>
						</button>
					{/each}
				</div>
			</div>
			<div>
				<span class="label">Printers</span>
				<Segmented label="Printers" items={[{ id: 'all', label: 'All printers' }, { id: 'some', label: 'Chosen printers' }]} active={form.which} onselect={(id) => (form.which = id as 'all' | 'some')} />
				{#if form.which === 'some'}
					<div class="mt-2 grid gap-1 sm:grid-cols-2" data-testid="mcp-printers">
						{#each printers.list as p (p.id)}
							<label class="flex min-h-9 items-center gap-2 rounded-lg px-2 text-[0.8125rem] hover:bg-accent touch:min-h-11">
								<input type="checkbox" class="accent-[var(--primary)]" checked={form.printers.includes(p.id)} onchange={(e) => togglePrinter(p.id, e.currentTarget.checked)} />
								{p.name}
							</label>
						{/each}
					</div>
				{/if}
			</div>
			<p class="flex items-start gap-1.5 text-[0.6875rem] text-muted-foreground">
				<CircleAlert class="mt-px size-3.5 shrink-0" />
				<span>The token acts as you and never exceeds your own role and printers: if your account is demoted or disabled, the token loses that access too. Every action it takes is in the audit log.</span>
			</p>
		</form>
	{:else}
		<div class="space-y-4" data-testid="mcp-created">
			<div class="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2">
				<KeyRound class="size-4 shrink-0 text-success" />
				<code class="min-w-0 flex-1 font-mono text-xs break-all select-all">{created.token}</code>
				<button class="btn btn-secondary btn-sm touch:h-11" onclick={() => copy(created!.token, 'Token copied')}><Copy />Copy</button>
			</div>
			<p class="text-[0.6875rem] text-muted-foreground">{created.record.destination}{created.record.expiresAt ? ` · expires ${new Date(created.record.expiresAt).toLocaleDateString()}` : ''}</p>
			<div>
				<Segmented
					label="Client"
					items={[
						{ id: 'code', label: 'Claude Code' },
						{ id: 'desktop', label: 'Claude Desktop' },
						{ id: 'other', label: 'Other clients' }
					]}
					active={client}
					onselect={(id) => (client = id as typeof client)}
				/>
				<p class="mt-2 text-[0.6875rem] text-muted-foreground">
					{#if client === 'code'}
						Run in a terminal; then <code class="font-mono">/mcp</code> in Claude Code lists octo·modern’s tools.
					{:else if client === 'desktop'}
						Add to <code class="font-mono">claude_desktop_config.json</code> (Settings → Developer → Edit Config) and restart Claude Desktop. Needs Node.js for <code class="font-mono">npx mcp-remote</code>.
					{:else}
						Any MCP client with Streamable HTTP and custom headers. claude.ai custom connectors need OAuth, which isn’t supported yet.
					{/if}
				</p>
				<div class="relative mt-2">
					<pre class="max-h-64 overflow-auto rounded-lg border border-border bg-surface p-3 pr-20 font-mono text-[0.6875rem] leading-relaxed break-all whitespace-pre-wrap" data-testid="mcp-snippet">{snippet}</pre>
					<button class="btn btn-secondary btn-sm absolute top-2 right-2 touch:h-11" onclick={() => copy(snippet, 'Snippet copied')}><Copy />Copy</button>
				</div>
			</div>
		</div>
	{/if}
	{#snippet footer()}
		{#if created}
			<button class="btn btn-primary" onclick={() => (open = false)}>Done</button>
		{:else}
			<button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
			<button class="btn btn-primary" form="mcp-form" disabled={busy || !canCreate}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<Bot />{/if}Create token</button>
		{/if}
	{/snippet}
</Dialog>
