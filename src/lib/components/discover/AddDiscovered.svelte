<script lang="ts">
	import { onDestroy } from 'svelte';
	import { CircleAlert, CircleCheck, ExternalLink, KeyRound, LoaderCircle, ShieldCheck, TriangleAlert, X } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import Switch from '../Switch.svelte';
	import { api, ApiError, errorMessage } from '#lib/client/api.ts';
	import type { AppKeyRequestState, Candidate } from '#lib/discovery.ts';
	import type { Printer, TestResult } from '#lib/types.ts';

	let {
		target = $bindable(null),
		onadded
	}: {
		/** The candidate being added and the address picked for it; null closes the dialog. */
		target: { candidate: Candidate; url: string } | null;
		onadded: (printer: Printer, test: TestResult) => void;
	} = $props();

	let name = $state('');
	let baseUrl = $state('');
	let verifyTls = $state(true);
	let method = $state<'appkey' | 'paste'>('appkey');
	let apiKey = $state('');
	let user = $state('');
	let request = $state<AppKeyRequestState | null>(null);
	let browserBase = $state('');
	let busy = $state(false);
	let error = $state('');
	let failedTest = $state<TestResult | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	const open = $derived(target !== null);
	// Klipper (Moonraker): no Application Keys; a key only if Moonraker asks for one.
	const klipper = $derived(target?.candidate.fingerprint.kind === 'moonraker');
	const https = $derived(/^https:/i.test(baseUrl));

	/** Where the browser (not octo·modern's server) can open OctoPrint. */
	function guessBrowserBase(url: string): string {
		try {
			const u = new URL(url);
			const internal = /^(localhost|127\.|host\.docker\.internal$)/.test(u.hostname) || (!u.hostname.includes('.') && !u.hostname.includes(':'));
			if (internal) u.hostname = location.hostname;
			return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
		} catch {
			return url;
		}
	}

	$effect(() => {
		const t = target;
		stopPolling();
		request = null;
		error = '';
		failedTest = null;
		apiKey = '';
		user = '';
		if (!t) return;
		name = t.candidate.saved?.name ?? t.candidate.name;
		baseUrl = t.url;
		verifyTls = !t.candidate.insecureTls;
		method = t.candidate.fingerprint.kind !== 'moonraker' && (t.candidate.fingerprint.appkeys || t.candidate.fingerprint.confidence !== 'none') ? 'appkey' : 'paste';
		browserBase = guessBrowserBase(t.url);
	});

	const approveLink = $derived.by(() => {
		if (!request?.authDialog) return browserBase;
		try {
			const u = new URL(request.authDialog);
			const base = new URL(baseUrl);
			// OctoPrint built the link from the address octo·modern used; keep its path under the browser's base.
			const path = u.pathname.startsWith(base.pathname) ? u.pathname.slice(base.pathname.replace(/\/+$/, '').length) : u.pathname;
			return `${browserBase.replace(/\/+$/, '')}${path}${u.search}`;
		} catch {
			return request.authDialog;
		}
	});

	function stopPolling() {
		clearInterval(timer);
		timer = undefined;
	}

	async function cancelRequest() {
		stopPolling();
		if (request?.state === 'pending') await api.del(`/api/discover/appkey/${request.id}`).catch(() => {});
		request = null;
	}

	onDestroy(() => void cancelRequest());

	async function requestKey() {
		error = '';
		failedTest = null;
		busy = true;
		try {
			request = await api.post<AppKeyRequestState>('/api/discover/appkey', { baseUrl, verifyTls, user: user.trim() || undefined });
			if (request.state === 'pending') {
				timer = setInterval(poll, 1200);
			}
		} catch (err) {
			error = errorMessage(err);
		} finally {
			busy = false;
		}
	}

	async function poll() {
		if (!request) return stopPolling();
		try {
			request = await api.get<AppKeyRequestState>(`/api/discover/appkey/${request.id}`);
		} catch (err) {
			stopPolling();
			error = errorMessage(err);
			return;
		}
		if (request.state !== 'pending') {
			stopPolling();
			if (request.state === 'approved') await save();
		}
	}

	async function save(force = false) {
		if (!target) return;
		busy = true;
		error = '';
		try {
			const res = await api.post<{ printer: Printer; test: TestResult }>('/api/discover/import', {
				key: target.candidate.key,
				name,
				baseUrl,
				verifyTls,
				kind: klipper ? 'moonraker' : 'octoprint',
				...(method === 'appkey' && request ? { appKeyRequest: request.id } : { apiKey }),
				force
			});
			onadded(res.printer, res.test);
			target = null;
		} catch (err) {
			if (err instanceof ApiError && err.status === 422) failedTest = (err.detail as unknown as { test: TestResult }).test;
			else error = errorMessage(err);
		} finally {
			busy = false;
		}
	}

	function close() {
		void cancelRequest();
		target = null;
	}
</script>

<Dialog
	bind:open={() => open, (v) => !v && close()}
	title={target ? `Add ${target.candidate.name}` : 'Add printer'}
	description={klipper ? 'A Klipper printer (Moonraker). It needs an API key only if Moonraker isn’t set to trust octo·modern’s address.' : 'octo·modern needs an API key. Approve it in OctoPrint, or paste one.'}
	width="max-w-xl"
>
	<div class="space-y-4">
		<div class="grid gap-3 sm:grid-cols-[1fr_1.5fr]">
			<div>
				<label class="label" for="d-name">Name</label>
				<input id="d-name" class="input" bind:value={name} disabled={!!request} />
			</div>
			<div>
				<label class="label" for="d-url">{klipper ? 'Moonraker URL' : 'OctoPrint URL'}</label>
				<input id="d-url" class="input font-mono text-[0.8125rem]" bind:value={baseUrl} disabled={!!request} oninput={() => (browserBase = guessBrowserBase(baseUrl))} />
			</div>
		</div>
		{#if https}
			<div class="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
				<p class="flex-1 text-xs">Verify TLS certificate <span class="text-muted-foreground">· turn off for a self-signed certificate</span></p>
				<Switch label="Verify TLS certificate" bind:checked={verifyTls} disabled={!!request} />
			</div>
		{/if}

		{#if !klipper}
		<div class="inline-flex rounded-lg border border-border bg-surface p-0.5" role="tablist">
			{#each [{ id: 'appkey', label: 'Approve in OctoPrint', icon: ShieldCheck }, { id: 'paste', label: 'Paste a key', icon: KeyRound }] as m (m.id)}
				<button type="button"
					role="tab"
					aria-selected={method === m.id}
					class="flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition {method === m.id ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
					disabled={!!request && request.state === 'pending'}
					onclick={() => (method = m.id as typeof method)}><m.icon class="size-3.5" />{m.label}</button
				>
			{/each}
		</div>
		{/if}

		{#if method === 'appkey' && !klipper}
			{#if !request || request.state === 'error' || request.state === 'denied' || request.state === 'expired'}
				<p class="text-xs text-muted-foreground">
					octo·modern asks OctoPrint for an Application Key named <span class="font-medium text-foreground">octo·modern</span>. You approve it in OctoPrint, signed in as
					the user whose permissions the key should have (an admin for full control).
				</p>
				<div>
					<label class="label" for="d-user">OctoPrint user <span class="font-normal">· optional</span></label>
					<input id="d-user" class="input h-8 text-[0.8125rem]" placeholder="Only this user may approve" bind:value={user} />
				</div>
				{#if request}
					<p class="flex items-start gap-1.5 text-xs {request.state === 'error' ? 'text-danger' : 'text-warning'}"><CircleAlert class="mt-px size-3.5 shrink-0" />{request.message}</p>
				{/if}
			{:else if request.state === 'pending'}
				<div class="rounded-xl border border-primary/30 bg-primary-soft/40 p-4">
					<div class="flex items-center gap-2 text-[0.8125rem] font-medium"><LoaderCircle class="size-4 animate-spin text-primary" />Waiting for approval in OctoPrint…</div>
					<p class="mt-1.5 text-xs text-muted-foreground">
						Open OctoPrint and allow access for <span class="font-medium text-foreground">octo·modern</span>. Admins already signed in to OctoPrint also get a prompt there.
					</p>
					<a class="btn btn-primary btn-sm mt-3" href={approveLink} target="_blank" rel="noopener noreferrer"><ExternalLink />Approve in OctoPrint</a>
					<details class="mt-3 text-[0.6875rem] text-muted-foreground">
						<summary class="cursor-pointer select-none hover:text-foreground">Link doesn’t open?</summary>
						<p class="mt-1.5">octo·modern reaches OctoPrint at <span class="font-mono">{baseUrl}</span>, which your browser may not. Enter the address you use for OctoPrint:</p>
						<input class="input mt-1.5 h-8 font-mono text-xs" bind:value={browserBase} aria-label="OctoPrint address in your browser" />
					</details>
					<p class="mt-2 text-[0.6875rem] text-muted-foreground">Gives up in {Math.floor(request.expiresIn / 60)}:{String(request.expiresIn % 60).padStart(2, '0')}.</p>
				</div>
			{:else if request.state === 'approved'}
				<p class="flex items-center gap-1.5 text-[0.8125rem] text-success"><CircleCheck class="size-4" />Approved. {busy ? 'Testing and saving…' : ''}</p>
			{/if}
		{:else}
			<div>
				<label class="label" for="d-key">API key{#if klipper}<span class="font-normal"> · optional</span>{/if}</label>
				<!-- svelte-ignore a11y_autofocus -->
				<input id="d-key" class="input font-mono text-[0.8125rem]" type="password" autocomplete="off" autofocus placeholder={klipper ? 'Leave empty on a trusted network' : 'Application Key or user API key'} bind:value={apiKey} />
				{#if klipper}
					<p class="mt-1 text-[0.6875rem] text-muted-foreground">Only if Moonraker asks for one (Mainsail: <b class="font-medium text-foreground">Settings → Authorization</b>). Otherwise add octo·modern’s address to <code class="font-mono">trusted_clients</code> in moonraker.conf.</p>
				{:else}
				<p class="mt-1 text-[0.6875rem] text-muted-foreground">In OctoPrint: <b class="font-medium text-foreground">Settings → Application Keys</b>, or <b class="font-medium text-foreground">User Settings → API key</b>.</p>
				{/if}
			</div>
		{/if}

		{#if failedTest && !failedTest.ok}
			<div class="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs">
				<TriangleAlert class="size-4 shrink-0 text-danger" />
				<div class="min-w-0 flex-1">
					<p class="font-medium">Test failed: {failedTest.error.message}</p>
					{#if failedTest.error.hint}<p class="mt-0.5 text-muted-foreground">{failedTest.error.hint}</p>{/if}
					<button type="button" class="btn btn-secondary btn-sm mt-2" disabled={busy} onclick={() => save(true)}>Save anyway</button>
				</div>
			</div>
		{/if}
		{#if error}<p class="flex items-start gap-1.5 text-xs text-danger"><CircleAlert class="mt-px size-3.5 shrink-0" />{error}</p>{/if}
	</div>
	{#snippet footer()}
		{#if request?.state === 'pending'}
			<button type="button" class="btn btn-ghost mr-auto" onclick={cancelRequest}><X />Stop waiting</button>
		{/if}
		<button type="button" class="btn btn-secondary" onclick={close}>Cancel</button>
		{#if method === 'appkey' && !klipper && request?.state !== 'pending'}
			<button type="button" class="btn btn-primary" disabled={busy || !baseUrl || request?.state === 'approved'} onclick={requestKey}>
				{#if busy}<LoaderCircle class="animate-spin" />{:else}<ShieldCheck />{/if}{request ? 'Request again' : 'Request a key'}
			</button>
		{:else if method === 'paste' || klipper}
			<button type="button" class="btn btn-primary" disabled={busy || !baseUrl || (!klipper && apiKey.trim().length < 8)} onclick={() => save()}>
				{#if busy}<LoaderCircle class="animate-spin" />{/if}Test and add
			</button>
		{/if}
	{/snippet}
</Dialog>
