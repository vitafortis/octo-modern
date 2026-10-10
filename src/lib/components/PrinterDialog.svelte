<script lang="ts">
	import { goto } from '$app/navigation';
	import { CircleAlert, CircleCheck, LoaderCircle, Lock, Trash2, TriangleAlert, Zap } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import Switch from './Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { removePrinter } from '#lib/client/printers.ts';
	import { editor, refreshPrinters, refreshStatuses, toast } from '#lib/client/state.svelte.ts';
	import type { Printer, TestResult } from '#lib/types.ts';

	type Form = { name: string; baseUrl: string; apiKey: string; verifyTls: boolean; webcamUrl: string; color: string };
	const blank = (): Form => ({ name: '', baseUrl: '', apiKey: '', verifyTls: true, webcamUrl: '', color: 'violet' });

	let form = $state<Form>(blank());
	let changeKey = $state(true);
	let saving = $state(false);
	let testing = $state(false);
	let test = $state<TestResult | null>(null);

	const editing = $derived(editor.target && editor.target !== 'new' ? editor.target : null);
	const open = $derived(editor.target !== null);

	$effect(() => {
		const t = editor.target;
		test = null;
		if (t === 'new') {
			form = blank();
			changeKey = true;
		} else if (t) {
			form = { name: t.name, baseUrl: t.baseUrl, apiKey: '', verifyTls: t.verifyTls, webcamUrl: t.webcamUrl ?? '', color: t.color };
			changeKey = !t.hasApiKey;
		}
	});

	const https = $derived(/^\s*https:/i.test(form.baseUrl));

	function payload() {
		return { ...form, apiKey: changeKey ? form.apiKey : undefined };
	}

	async function runTest() {
		testing = true;
		test = null;
		try {
			test = await api.post<TestResult>('/api/printers/test', { ...payload(), id: editing?.id });
		} catch (err) {
			test = { ok: false, error: { message: errorMessage(err) } };
		} finally {
			testing = false;
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		try {
			const saved = editing ? await api.put<Printer>(`/api/printers/${editing.id}`, payload()) : await api.post<Printer>('/api/printers', payload());
			await refreshPrinters();
			void refreshStatuses();
			toast('success', editing ? 'Printer updated' : 'Printer added', saved.name);
			editor.target = null;
			if (!editing) goto(`/p/${saved.id}`);
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		} finally {
			saving = false;
		}
	}
</script>

<Dialog
	bind:open={() => open, (v) => !v && (editor.target = null)}
	title={editing ? `Edit ${editing.name}` : 'Add a printer'}
	description="An OctoPrint server. Its API key is encrypted at rest and never sent to browsers."
	width="max-w-xl"
>
	<form id="printer-form" onsubmit={save} class="space-y-4">
		<div class="grid grid-cols-[1fr_auto] gap-3">
			<div>
				<label class="label" for="p-name">Name</label>
				<input id="p-name" class="input" placeholder="Prusa MK4" bind:value={form.name} />
			</div>
			<div>
				<span class="label">Color</span>
				<div class="flex h-9 items-center gap-1.5">
					{#each Object.entries(COLORS) as [key, value] (key)}
						<button
							type="button"
							aria-label={key}
							onclick={() => (form.color = key)}
							class="size-4 rounded-full ring-offset-2 ring-offset-card transition {form.color === key ? 'ring-2 ring-foreground/60' : ''}"
							style="background:{value}"
						></button>
					{/each}
				</div>
			</div>
		</div>

		<div>
			<label class="label" for="p-url">OctoPrint URL</label>
			<input id="p-url" class="input font-mono text-[13px]" required placeholder="http://octopi.lan or https://print.example.com/octoprint" bind:value={form.baseUrl} oninput={() => (test = null)} />
			<p class="mt-1 text-[11px] text-muted-foreground">As octo·modern’s server reaches it. Inside Docker, use the host’s IP rather than <code class="font-mono">localhost</code>; <code class="font-mono">.local</code> names usually don’t resolve in containers.</p>
		</div>

		<div>
			<label class="label" for="p-key">API key</label>
			{#if changeKey}
				<input id="p-key" class="input font-mono text-[13px]" type="password" autocomplete="off" required={!editing} placeholder="Application Key or user API key" bind:value={form.apiKey} oninput={() => (test = null)} />
				<p class="mt-1 text-[11px] text-muted-foreground">
					In OctoPrint: <b class="font-medium text-foreground">Settings → Application Keys</b> (generate one for “octo·modern”), or <b class="font-medium text-foreground">User Settings → API key</b>. The key acts with that user’s permissions.
				</p>
			{:else}
				<button type="button" class="btn btn-secondary h-9 w-full justify-start font-normal text-muted-foreground" onclick={() => (changeKey = true)}>
					<Lock />Stored encrypted — replace
				</button>
			{/if}
		</div>

		<div class="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 {https ? '' : 'opacity-60'}">
			<div class="flex-1">
				<p class="text-[13px] font-medium">Verify TLS certificate</p>
				<p class="text-[11px] text-muted-foreground">{https ? 'Turn off for a self-signed certificate on your LAN.' : 'Only applies to https:// URLs.'}</p>
			</div>
			<Switch label="Verify TLS certificate" bind:checked={form.verifyTls} disabled={!https} />
		</div>

		<details class="rounded-lg border border-border px-3 py-2.5" open={!!form.webcamUrl}>
			<summary class="cursor-pointer text-[13px] font-medium select-none">Webcam <span class="font-normal text-muted-foreground">· optional override</span></summary>
			<div class="mt-3">
				<label class="label" for="p-cam">Stream or snapshot URL</label>
				<input id="p-cam" class="input font-mono text-[13px]" placeholder="http://octopi.lan/webcam/?action=stream" bind:value={form.webcamUrl} />
				<p class="mt-1 text-[11px] text-muted-foreground">Leave empty to use OctoPrint’s webcam settings. Paths like <code class="font-mono">/webcam/?action=snapshot</code> are relative to the OctoPrint host; octo·modern fetches the images, so the browser doesn’t need to reach the camera.</p>
			</div>
		</details>

		{#if test}
			<div class="flex items-start gap-2 rounded-lg border p-3 text-xs {test.ok ? (test.missing.length ? 'border-warning/30 bg-warning/5' : 'border-success/30 bg-success/5') : 'border-danger/30 bg-danger/5'}">
				{#if test.ok}
					{#if test.missing.length}<TriangleAlert class="size-4 shrink-0 text-warning" />{:else}<CircleCheck class="size-4 shrink-0 text-success" />{/if}
					<div class="min-w-0">
						<p class="font-medium">OctoPrint {test.version} · key of <span class="font-mono">{test.user}</span> · {test.latencyMs} ms</p>
						{#if test.missing.length}
							<p class="mt-1 text-muted-foreground">This key lacks <span class="font-mono text-foreground">{test.missing.join(', ')}</span>; those features won’t work. Use a key of a user in OctoPrint’s admins group for full control.</p>
						{:else}
							<p class="mt-0.5 text-muted-foreground">{test.permissions.includes('ADMIN') ? 'Admin key: everything octo·modern does is allowed.' : 'The key has every permission octo·modern uses.'}</p>
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
		{#if editing}
			<button type="button" class="btn btn-ghost mr-auto text-danger hover:text-danger" onclick={() => editing && removePrinter(editing)}><Trash2 />Remove</button>
		{/if}
		<button type="button" class="btn btn-secondary" disabled={testing || !form.baseUrl || (changeKey && !form.apiKey)} onclick={runTest}>
			{#if testing}<LoaderCircle class="animate-spin" />{:else}<Zap />{/if}Test connection
		</button>
		<button class="btn btn-primary" form="printer-form" disabled={saving}>{#if saving}<LoaderCircle class="animate-spin" />{/if}{editing ? 'Save changes' : 'Add printer'}</button>
	{/snippet}
</Dialog>
