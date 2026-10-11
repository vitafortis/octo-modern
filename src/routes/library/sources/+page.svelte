<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { ArrowLeft, CircleAlert, CircleCheck, LoaderCircle, Lock, Pencil, Pin, Plus, Save, Trash2, Zap } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import SourceIcon from '#lib/components/library/SourceIcon.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, printers, toast } from '#lib/client/state.svelte.ts';
	import { describeSource, SOURCE_KIND_LABEL, SOURCE_KINDS, type LibrarySource, type SourceKind } from '#lib/library.ts';

	type Test =
		| { ok: true; folders: number; files: number; printable: number; sample: string[]; hostKey?: string; latencyMs: number }
		| { ok: false; error: { message: string; code?: string; hint?: string }; hostKey?: string };

	const blank = () => ({
		name: '',
		kind: 'folder' as SourceKind,
		path: '/library',
		host: '',
		port: '',
		share: '',
		domain: '',
		user: '',
		url: '',
		hostKey: '',
		verifyTls: true,
		writable: false,
		allPrinters: true,
		printers: [] as string[],
		password: '',
		privateKey: '',
		passphrase: ''
	});

	let sources = $state<LibrarySource[] | null>(null);
	let open = $state(false);
	let editing = $state<LibrarySource | null>(null);
	let form = $state(blank());
	let change = $state({ password: true, privateKey: true, passphrase: true });
	let test = $state<Test | null>(null);
	let testing = $state(false);
	let saving = $state(false);

	async function load() {
		try {
			sources = await api.get<LibrarySource[]>('/api/library/sources?manage=1');
		} catch (err) {
			toast('error', 'Could not load library sources', errorMessage(err));
		}
	}
	onMount(() => {
		void load();
		if (page.url.searchParams.get('new') === '1') edit(null);
	});

	function edit(s: LibrarySource | null) {
		editing = s;
		test = null;
		form = blank();
		change = { password: true, privateKey: true, passphrase: true };
		if (s) {
			const c = s.config as unknown as Record<string, unknown>;
			form = {
				...form,
				name: s.name,
				kind: s.kind,
				path: String(c.path ?? ''),
				host: String(c.host ?? ''),
				port: c.port ? String(c.port) : '',
				share: String(c.share ?? ''),
				domain: String(c.domain ?? ''),
				user: String(c.user ?? ''),
				url: String(c.url ?? ''),
				hostKey: String(c.hostKey ?? ''),
				verifyTls: c.verifyTls !== false,
				writable: s.writable,
				allPrinters: s.printers === 'all',
				printers: s.printers === 'all' ? [] : [...s.printers]
			};
			change = { password: !s.hasPassword, privateKey: !s.hasPrivateKey, passphrase: !s.hasPassphrase };
		}
		open = true;
	}

	function payload() {
		const f = form;
		const config =
			f.kind === 'folder'
				? { path: f.path }
				: f.kind === 'smb'
					? { host: f.host, port: f.port || undefined, share: f.share, path: f.path, domain: f.domain, user: f.user }
					: f.kind === 'sftp'
						? { host: f.host, port: f.port || undefined, user: f.user, path: f.path, hostKey: f.hostKey }
						: { url: f.url, user: f.user, verifyTls: f.verifyTls };
		const secrets: Record<string, string> = {};
		if (change.password && f.password) secrets.password = f.password;
		if (f.kind === 'sftp' && change.privateKey && f.privateKey) secrets.privateKey = f.privateKey;
		if (f.kind === 'sftp' && change.passphrase && f.passphrase) secrets.passphrase = f.passphrase;
		return {
			id: editing?.id,
			name: f.name,
			kind: f.kind,
			config,
			writable: f.writable,
			printers: f.allPrinters ? 'all' : f.printers,
			secrets: Object.keys(secrets).length ? secrets : undefined
		};
	}

	async function runTest() {
		testing = true;
		test = null;
		try {
			test = await api.post<Test>('/api/library/sources/test', payload());
		} catch (err) {
			test = { ok: false, error: { message: errorMessage(err) } };
		} finally {
			testing = false;
		}
		await tick();
		document.querySelector('[data-testid=source-test]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		try {
			const body = payload();
			const saved = editing ? await api.put<LibrarySource>(`/api/library/sources/${editing.id}`, body) : await api.post<LibrarySource>('/api/library/sources', body);
			toast('success', editing ? 'Library source updated' : 'Library source added', saved.name);
			open = false;
			await load();
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	async function remove(s: LibrarySource) {
		const ok = await confirmAction({
			title: `Remove ${s.name}?`,
			body: 'octo·modern forgets this source and its saved credentials. Nothing on the NAS is touched.',
			detail: describeSource(s),
			confirmLabel: 'Remove',
			danger: true
		});
		if (!ok) return;
		try {
			await api.del(`/api/library/sources/${s.id}`);
			toast('success', 'Removed', s.name);
			await load();
		} catch (err) {
			toast('error', 'Could not remove', errorMessage(err));
		}
	}

	const printerName = (id: string) => printers.list.find((p) => p.id === id)?.name ?? 'removed printer';
	const needsHost = $derived(form.kind === 'smb' || form.kind === 'sftp');
	const pathLabel = $derived({ folder: 'Folder in the container', smb: 'Folder in the share', sftp: 'Folder on the server', webdav: '' }[form.kind]);
	const pathHint = $derived(
		{
			folder: '/library',
			smb: 'optional, e.g. 3d/gcode',
			sftp: 'e.g. /volume1/3d/gcode (empty = home folder)',
			webdav: ''
		}[form.kind]
	);
</script>

{#snippet secret(field: 'password' | 'privateKey' | 'passphrase', label: string, placeholder: string)}
	<div class={field === 'privateKey' ? 'sm:col-span-2' : ''}>
		<label class="label" for="src-{field}">{label}</label>
		{#if change[field]}
			{#if field === 'privateKey'}
				<textarea id="src-{field}" class="input h-24 resize-y py-2 font-mono text-[0.6875rem]" spellcheck="false" {placeholder} bind:value={form[field]}></textarea>
			{:else}
				<input id="src-{field}" class="input font-mono text-xs" type="password" autocomplete="new-password" {placeholder} bind:value={form[field]} />
			{/if}
		{:else}
			<button type="button" class="btn btn-secondary h-9 w-full justify-start font-normal text-muted-foreground" onclick={() => (change[field] = true)}><Lock />Stored securely — change</button>
		{/if}
	</div>
{/snippet}

<svelte:head><title>Library sources · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Library sources" description="Where your G-code lives. Credentials are encrypted and never sent to browsers.">
		{#snippet actions()}
			<a href="/library" class="btn btn-ghost"><ArrowLeft />Library</a>
			<button class="btn btn-primary" onclick={() => edit(null)}><Plus />Add source</button>
		{/snippet}
	</PageHeader>

	<div class="max-w-5xl space-y-3 page-x pb-12">
		{#if !sources}
			<div class="grid h-32 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
		{:else if !sources.length}
			<div class="card px-6 py-10 text-center text-[0.8125rem] text-muted-foreground">No sources yet. <button class="text-primary hover:underline" onclick={() => edit(null)}>Add the first one</button>.</div>
		{:else}
			{#each sources as s (s.id)}
				<div class="card flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 max-sm:px-4" data-source={s.name}>
					<span class="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><SourceIcon kind={s.kind} class="size-5" /></span>
					<div class="min-w-0 flex-1">
						<p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
							{s.name}
							<span class="badge">{SOURCE_KIND_LABEL[s.kind]}</span>
							{#if s.writable}<span class="badge badge-warning">Writable</span>{:else}<span class="badge">Read-only</span>{/if}
						</p>
						<p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">{describeSource(s)}</p>
						<p class="mt-0.5 text-[0.6875rem] text-muted-foreground">
							{s.printers === 'all' ? 'All printers' : s.printers.length ? s.printers.map(printerName).join(', ') : 'No printers'}
						</p>
					</div>
					<!-- Phones: the buttons get their own row under the description. -->
					<div class="flex items-center gap-2 max-sm:w-full max-sm:pl-14 max-sm:[&>.btn-secondary]:flex-1">
					<button class="btn btn-secondary btn-sm" onclick={() => edit(s)}><Pencil />Edit</button>
					<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Remove {s.name}" aria-label="Remove {s.name}" onclick={() => remove(s)}><Trash2 /></button>
					</div>
				</div>
			{/each}
		{/if}

		<section class="card mt-6 space-y-2 p-5 text-xs text-muted-foreground">
			<h2 class="text-[0.8125rem] font-semibold text-foreground">Which type?</h2>
			<p><strong class="text-foreground">Folder</strong> is the recommended NAS route: let Docker mount the NFS or SMB share as a volume (see <code class="font-mono">compose.yaml</code>) and point the source at it. Nothing to install on the NAS, and the fastest option.</p>
			<p><strong class="text-foreground">SMB share</strong> talks SMB 2.1/3 directly, without mounting (NTLMv2 user and password; Windows, Synology, TrueNAS, Unraid, Samba).</p>
			<p><strong class="text-foreground">SFTP</strong> works with any SSH server; pin the host key after a successful test. <strong class="text-foreground">WebDAV</strong> covers Nextcloud, ownCloud and Synology WebDAV Server.</p>
			<p>Sources are read-only unless you allow writing, which enables <em>Save to library</em> from a printer’s files.</p>
		</section>
	</div>
</div>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : 'Add a library source'} description="A folder of G-code on your NAS." width="max-w-2xl">
	<form id="source-form" class="space-y-4" onsubmit={save}>
		<div class="grid gap-3 sm:grid-cols-[1fr_auto]">
			<div>
				<label class="label" for="src-name">Name</label>
				<input id="src-name" class="input" placeholder="NAS prints" bind:value={form.name} />
			</div>
			<div>
				<span class="label">Type</span>
				<div class="inline-flex h-9 rounded-lg border border-border bg-surface p-0.5 max-sm:grid max-sm:h-auto max-sm:w-full max-sm:grid-cols-2" role="radiogroup" aria-label="Type">
					{#each SOURCE_KINDS as k (k)}
						<button
							type="button"
							role="radio"
							aria-checked={form.kind === k}
							class="flex items-center gap-1.5 rounded-md px-2.5 text-xs touch:min-h-10 {form.kind === k ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
							onclick={() => ((form.kind = k), (test = null), k === 'folder' && !form.path.startsWith('/') && (form.path = '/library'))}
						>
							<SourceIcon kind={k} class="size-3.5" />{SOURCE_KIND_LABEL[k]}
						</button>
					{/each}
				</div>
			</div>
		</div>

		<div class="grid gap-3 sm:grid-cols-2">
			{#if needsHost}
				<div class="grid grid-cols-[1fr_6rem] gap-2 sm:col-span-2">
					<div>
						<label class="label" for="src-host">Host</label>
						<input id="src-host" class="input font-mono text-xs" required placeholder="nas.lan or 192.168.1.10" bind:value={form.host} />
					</div>
					<div>
						<label class="label" for="src-port">Port</label>
						<input id="src-port" class="input font-mono text-xs" inputmode="numeric" placeholder={form.kind === 'smb' ? '445' : '22'} bind:value={form.port} />
					</div>
				</div>
			{/if}
			{#if form.kind === 'smb'}
				<div>
					<label class="label" for="src-share">Share</label>
					<input id="src-share" class="input font-mono text-xs" required placeholder="prints" bind:value={form.share} />
				</div>
			{/if}
			{#if form.kind === 'webdav'}
				<div class="sm:col-span-2">
					<label class="label" for="src-url">Folder URL</label>
					<input id="src-url" class="input font-mono text-xs" required placeholder="https://cloud.example.com/remote.php/dav/files/me/Prints" bind:value={form.url} />
				</div>
			{:else}
				<div class={form.kind === 'smb' ? '' : 'sm:col-span-2'}>
					<label class="label" for="src-path">{pathLabel}</label>
					<input id="src-path" class="input font-mono text-xs" required={form.kind === 'folder'} placeholder={pathHint} bind:value={form.path} />
					{#if form.kind === 'folder'}<p class="mt-1 text-[0.6875rem] text-muted-foreground">An absolute path inside octo·modern’s container, typically a NAS share mounted as a volume.</p>{/if}
				</div>
			{/if}
			{#if form.kind !== 'folder'}
				<div>
					<label class="label" for="src-user">User</label>
					<input id="src-user" class="input font-mono text-xs" required={form.kind !== 'webdav'} autocomplete="off" bind:value={form.user} />
				</div>
				{@render secret('password', 'Password', form.kind === 'sftp' ? 'or use a private key' : '')}
			{/if}
			{#if form.kind === 'sftp'}
				<div class="sm:col-span-2">
					<label class="label" for="src-hostkey">Pinned host key (optional)</label>
					<input id="src-hostkey" class="input font-mono text-[0.6875rem]" placeholder="SHA256:… — Test shows the server’s key" bind:value={form.hostKey} />
				</div>
				<details class="sm:col-span-2" open={!!editing?.hasPrivateKey}>
					<summary class="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">Sign in with a private key</summary>
					<div class="mt-3 grid gap-3 sm:grid-cols-2">
						{@render secret('privateKey', 'Private key', '-----BEGIN OPENSSH PRIVATE KEY-----')}
						{@render secret('passphrase', 'Key passphrase (optional)', '')}
					</div>
				</details>
			{/if}
			{#if form.kind === 'smb'}
				<div>
					<label class="label" for="src-domain">Domain (optional)</label>
					<input id="src-domain" class="input font-mono text-xs" placeholder="WORKGROUP" bind:value={form.domain} />
				</div>
			{/if}
			{#if form.kind === 'webdav'}
				<label class="flex items-center gap-2 self-end pb-2 text-[0.8125rem]"><Switch label="Verify TLS certificate" bind:checked={form.verifyTls} />Verify TLS certificate</label>
			{/if}
		</div>

		<div class="space-y-3 rounded-lg border border-border p-3">
			<div class="flex items-center gap-3">
				<div class="flex-1">
					<p class="text-[0.8125rem] font-medium">Allow writing</p>
					<p class="text-[0.6875rem] text-muted-foreground">Lets operators save printer files to this source (<em>Save to library</em>). Off: octo·modern only ever reads.</p>
				</div>
				<Switch label="Allow writing" bind:checked={form.writable} />
			</div>
			<div class="flex items-center gap-3 border-t border-border pt-3">
				<div class="flex-1">
					<p class="text-[0.8125rem] font-medium">Available to every printer</p>
					<p class="text-[0.6875rem] text-muted-foreground">Or pick the printers that may print from it. People see sources usable with a printer they can see.</p>
				</div>
				<Switch label="Available to every printer" bind:checked={form.allPrinters} />
			</div>
			{#if !form.allPrinters}
				<div class="flex flex-wrap gap-2">
					{#each printers.list as p (p.id)}
						<label class="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs {form.printers.includes(p.id) ? 'border-primary/50 bg-primary-soft' : ''}">
							<input type="checkbox" class="accent-[var(--primary)]" value={p.id} bind:group={form.printers} />{p.name}
						</label>
					{:else}
						<p class="text-xs text-muted-foreground">No printers yet.</p>
					{/each}
				</div>
			{/if}
		</div>

		{#if test}
			<div class="flex items-start gap-2 rounded-lg border p-3 text-xs {test.ok ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'}" data-testid="source-test">
				{#if test.ok}
					<CircleCheck class="size-4 shrink-0 text-success" />
					<div class="min-w-0 flex-1">
						<p class="font-medium">Connected in {test.latencyMs} ms — {test.folders} folder{test.folders === 1 ? '' : 's'}, {test.printable} G-code file{test.printable === 1 ? '' : 's'}{test.files > test.printable ? ` (+${test.files - test.printable} other)` : ''} at the top</p>
						{#if test.sample.length}<p class="mt-1 truncate font-mono text-muted-foreground">{test.sample.join('  ')}</p>{/if}
						{#if test.hostKey}
							<p class="mt-1.5 flex flex-wrap items-center gap-2 text-muted-foreground">
								Host key <code class="font-mono">{test.hostKey}</code>
								{#if form.hostKey !== test.hostKey}<button type="button" class="btn btn-secondary btn-sm" onclick={() => (form.hostKey = test && test.hostKey ? test.hostKey : '')}><Pin />Pin it</button>{:else}<span class="badge badge-success">pinned</span>{/if}
							</p>
						{/if}
					</div>
				{:else}
					<CircleAlert class="size-4 shrink-0 text-danger" />
					<div class="min-w-0">
						<p class="font-medium">{test.error.message}</p>
						{#if test.error.hint}<p class="mt-0.5 text-muted-foreground">{test.error.hint}</p>{/if}
					</div>
				{/if}
			</div>
		{/if}
	</form>
	{#snippet footer()}
		<button type="button" class="btn btn-secondary mr-auto" disabled={testing} onclick={runTest}>
			{#if testing}<LoaderCircle class="animate-spin" />{:else}<Zap />{/if}Test
		</button>
		<button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
		<button form="source-form" class="btn btn-primary" disabled={saving}><Save />{editing ? 'Save changes' : 'Add source'}</button>
	{/snippet}
</Dialog>
