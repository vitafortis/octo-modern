<script lang="ts">
	import { goto } from '$app/navigation';
	import { CircleAlert, CircleCheck, LoaderCircle, Lock, PlugZap, Trash2, TriangleAlert, Zap } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import PowerConfigDialog from './power/PowerConfigDialog.svelte';
	import Switch from './Switch.svelte';
	import BedMeshHint from './bedmesh/BedMeshHint.svelte';
	import PrinterPrePrint from './preprint/PrinterPrePrint.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { removePrinter } from '#lib/client/printers.ts';
	import { editor, isAdmin, refreshPrinters, refreshStatuses, toast } from '#lib/client/state.svelte.ts';
	import { plugs } from '#lib/client/power.svelte.ts';
	import { KIND_LABEL } from '#lib/printer-kind.ts';
	import type { Printer, PrinterKind, TestResult } from '#lib/types.ts';

	type KindChoice = PrinterKind | 'auto';
	type Form = { name: string; kind: KindChoice; baseUrl: string; apiKey: string; verifyTls: boolean; webcamUrl: string; color: string };
	const blank = (): Form => ({ name: '', kind: 'auto', baseUrl: '', apiKey: '', verifyTls: true, webcamUrl: '', color: 'violet' });
	const KINDS: { value: KindChoice; label: string; hint: string }[] = [
		{ value: 'auto', label: 'Auto-detect', hint: 'Probes the URL for Moonraker, then OctoPrint' },
		{ value: 'octoprint', label: 'OctoPrint', hint: 'OctoPrint server (OctoPi, Docker, …)' },
		{ value: 'moonraker', label: 'Klipper', hint: 'Klipper via Moonraker (Mainsail, Fluidd)' }
	];

	let form = $state<Form>(blank());
	let changeKey = $state(true);
	let saving = $state(false);
	let testing = $state(false);
	let test = $state<TestResult | null>(null);
	let prepSection = $state<PrinterPrePrint>();

	const editing = $derived(editor.target && editor.target !== 'new' ? editor.target : null);
	const open = $derived(editor.target !== null);
	// Smart plug setup lives here (the dashboard shows a Power card only once a plug exists).
	let plugFor = $state<Printer | null>(null);
	let plugOpen = $state(false);
	function setUpPlug() {
		if (!editing) return;
		plugFor = editing;
		editor.target = null;
		plugOpen = true;
	}

	$effect(() => {
		const t = editor.target;
		test = null;
		if (t === 'new') {
			form = blank();
			changeKey = true;
		} else if (t) {
			form = { name: t.name, kind: t.kind, baseUrl: t.baseUrl, apiKey: '', verifyTls: t.verifyTls, webcamUrl: t.webcamUrl ?? '', color: t.color };
			changeKey = !t.hasApiKey;
		}
	});

	const https = $derived(/^\s*https:/i.test(form.baseUrl));
	// What the form is about: the chosen type, or what the last test found.
	const kind = $derived<PrinterKind | null>(form.kind !== 'auto' ? form.kind : test?.ok && test.kind ? test.kind : null);
	const keyRequired = $derived(kind === 'octoprint');
	const server = $derived(kind === 'moonraker' ? 'Moonraker' : kind === 'octoprint' ? 'OctoPrint' : 'server');

	function pickKind(k: KindChoice) {
		form.kind = k;
		test = null;
	}

	function payload() {
		// Auto-detect resolved by a test: save what answered.
		const k = form.kind === 'auto' && test?.ok && test.kind ? test.kind : form.kind;
		return { ...form, kind: k, apiKey: changeKey ? form.apiKey : undefined };
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
		const prepProblem = prepSection?.problem();
		if (prepProblem) {
			toast('error', 'Check “Before each print”', prepProblem);
			return;
		}
		saving = true;
		try {
			if (editing) await prepSection?.save();
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
	description="An OctoPrint server or a Klipper printer (Moonraker). Its API key is encrypted at rest and never sent to browsers."
	width="max-w-xl"
>
	<form id="printer-form" onsubmit={save} class="space-y-4">
		<div>
			<span class="label" id="p-kind-label">Type</span>
			<div class="grid grid-cols-3 gap-1 rounded-xl border border-border bg-surface p-1" role="radiogroup" aria-labelledby="p-kind-label" data-testid="kind-picker">
				{#each KINDS.filter((k) => !editing || k.value !== 'auto') as k (k.value)}
					<button
						type="button"
						role="radio"
						aria-checked={form.kind === k.value}
						title={k.hint}
						onclick={() => pickKind(k.value)}
						class="flex min-h-9 flex-col items-center justify-center rounded-lg px-2 py-1.5 text-center text-[0.8125rem] font-medium transition touch:min-h-11 {form.kind === k.value ? 'bg-card text-foreground shadow-surface ring-1 ring-primary/40' : 'text-muted-foreground hover:text-foreground'}"
					>
						{k.label}
						<span class="hidden text-[0.6875rem] font-normal text-muted-foreground sm:block">{k.value === 'auto' ? 'probe the URL' : k.value === 'octoprint' ? 'API key' : 'via Moonraker'}</span>
					</button>
				{/each}
			</div>
			{#if form.kind === 'auto'}
				<p class="mt-1 text-[0.6875rem] text-muted-foreground">{test?.ok && test.kind ? `Found ${KIND_LABEL[test.kind]}${test.kind === 'moonraker' ? ' (Moonraker)' : ''}; it’s saved as that.` : 'Test the connection to see what answers, or just add it: the type is detected on save.'}</p>
			{/if}
		</div>

		<div class="grid gap-3 sm:grid-cols-[1fr_auto]">
			<div>
				<label class="label" for="p-name">Name</label>
				<input id="p-name" class="input" placeholder="Prusa MK4" bind:value={form.name} />
			</div>
			<div>
				<span class="label">Color</span>
				<div class="flex h-9 items-center gap-1.5 touch:h-11 touch:gap-0">
					{#each Object.entries(COLORS) as [key, value] (key)}
						<button
							type="button"
							aria-label={key}
							onclick={() => (form.color = key)}
							class="grid size-4 place-items-center rounded-full transition touch:size-10"
						><span class="size-4 rounded-full ring-offset-2 ring-offset-card touch:size-6 {form.color === key ? 'ring-2 ring-foreground/60' : ''}" style="background:{value}"></span></button>
					{/each}
				</div>
			</div>
		</div>

		<div>
			<label class="label" for="p-url">{kind === 'moonraker' ? 'Moonraker URL' : kind === 'octoprint' ? 'OctoPrint URL' : 'URL'}</label>
			<input id="p-url" class="input font-mono text-[0.8125rem]" required placeholder={kind === 'moonraker' ? 'http://voron.lan:7125 or http://voron.lan (Mainsail/Fluidd host)' : 'http://octopi.lan or https://print.example.com/octoprint'} bind:value={form.baseUrl} oninput={() => (test = null)} />
			<p class="mt-1 text-[0.6875rem] text-muted-foreground">As octo·modern’s server reaches it. Inside Docker, use the host’s IP rather than <code class="font-mono">localhost</code>; <code class="font-mono">.local</code> names usually don’t resolve in containers.</p>
		</div>

		<div>
			<label class="label" for="p-key">API key{#if !keyRequired}<span class="font-normal text-muted-foreground">&nbsp;· {kind === 'moonraker' ? 'optional' : 'needed for OctoPrint'}</span>{/if}</label>
			{#if changeKey}
				<input id="p-key" class="input font-mono text-[0.8125rem]" type="password" autocomplete="off" required={!editing && keyRequired} placeholder={kind === 'moonraker' ? 'Moonraker API key (leave empty on a trusted network)' : 'Application Key or user API key'} bind:value={form.apiKey} oninput={() => (test = null)} />
				<p class="mt-1 text-[0.6875rem] text-muted-foreground">
					{#if kind === 'moonraker'}
						Only if Moonraker asks for one: copy it from Mainsail (<b class="font-medium text-foreground">Settings → Authorization</b>) or Fluidd, or <code class="font-mono">GET /access/api_key</code>. Without a key, octo·modern’s address must be in <code class="font-mono">trusted_clients</code> in moonraker.conf.
					{:else}
						In OctoPrint: <b class="font-medium text-foreground">Settings → Application Keys</b> (generate one for “octo·modern”), or <b class="font-medium text-foreground">User Settings → API key</b>. The key acts with that user’s permissions.{#if kind === null} Klipper (Moonraker) usually needs none.{/if}
					{/if}
				</p>
			{:else}
				<button type="button" class="btn btn-secondary h-9 w-full justify-start font-normal text-muted-foreground" onclick={() => (changeKey = true)}>
					<Lock />Stored encrypted — replace
				</button>
			{/if}
		</div>

		<div class="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 {https ? '' : 'opacity-60'}">
			<div class="flex-1">
				<p class="text-[0.8125rem] font-medium">Verify TLS certificate</p>
				<p class="text-[0.6875rem] text-muted-foreground">{https ? 'Turn off for a self-signed certificate on your LAN.' : 'Only applies to https:// URLs.'}</p>
			</div>
			<Switch label="Verify TLS certificate" bind:checked={form.verifyTls} disabled={!https} />
		</div>

		<details class="rounded-lg border border-border px-3 py-2.5" open={!!form.webcamUrl}>
			<summary class="cursor-pointer text-[0.8125rem] font-medium select-none">Webcam <span class="font-normal text-muted-foreground">· optional override</span></summary>
			<div class="mt-3">
				<label class="label" for="p-cam">Stream or snapshot URL</label>
				<input id="p-cam" class="input font-mono text-[0.8125rem]" placeholder="http://octopi.lan/webcam/?action=stream" bind:value={form.webcamUrl} />
				<p class="mt-1 text-[0.6875rem] text-muted-foreground">Leave empty to use {kind === 'moonraker' ? 'the webcams configured in Mainsail/Fluidd (Moonraker)' : 'OctoPrint’s webcam settings'}. Paths like <code class="font-mono">/webcam/?action=snapshot</code> are relative to the {server} host; octo·modern fetches the images, so the browser doesn’t need to reach the camera.</p>
			</div>
		</details>

		{#if editing && isAdmin()}
			<div class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
				<div class="min-w-0">
					<p class="text-[0.8125rem] font-medium">Smart plug</p>
					<p class="text-[0.6875rem] text-muted-foreground">{plugs[editing.id] ? 'Set up. Change it or turn auto power-off on or off.' : 'Switch this printer with Shelly, Tasmota, Home Assistant or any HTTP switch.'}</p>
				</div>
				<button type="button" class="btn btn-secondary btn-sm shrink-0" onclick={setUpPlug} data-testid="power-setup"><PlugZap />{plugs[editing.id] ? 'Change' : 'Set up'}</button>
			</div>
			<BedMeshHint printerId={editing.id} />
			<PrinterPrePrint bind:this={prepSection} printerId={editing.id} />
		{/if}

		{#if test}
			<div class="flex items-start gap-2 rounded-lg border p-3 text-xs {test.ok ? (test.missing.length ? 'border-warning/30 bg-warning/5' : 'border-success/30 bg-success/5') : 'border-danger/30 bg-danger/5'}">
				{#if test.ok}
					{#if test.missing.length}<TriangleAlert class="size-4 shrink-0 text-warning" />{:else}<CircleCheck class="size-4 shrink-0 text-success" />{/if}
					<div class="min-w-0">
						{#if test.kind === 'moonraker'}
							<p class="font-medium">{test.version} · {test.latencyMs} ms</p>
							{#each test.notes ?? [] as n (n)}<p class="mt-0.5 text-muted-foreground">{n}</p>{/each}
						{:else}
						<p class="font-medium">OctoPrint {test.version} · key of <span class="font-mono">{test.user}</span> · {test.latencyMs} ms</p>
						{/if}
						{#if test.kind !== 'moonraker' && test.missing.length}
							<p class="mt-1 text-muted-foreground">This key lacks <span class="font-mono text-foreground">{test.missing.join(', ')}</span>; those features won’t work. Use a key of a user in OctoPrint’s admins group for full control.</p>
						{:else if test.kind !== 'moonraker'}
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
		<button type="button" class="btn btn-secondary" disabled={testing || !form.baseUrl || (keyRequired && changeKey && !form.apiKey)} onclick={runTest}>
			{#if testing}<LoaderCircle class="animate-spin" />{:else}<Zap />{/if}Test connection
		</button>
		<button class="btn btn-primary" form="printer-form" disabled={saving}>{#if saving}<LoaderCircle class="animate-spin" />{/if}{editing ? 'Save changes' : 'Add printer'}</button>
	{/snippet}
</Dialog>

{#if plugFor && isAdmin()}<PowerConfigDialog bind:open={plugOpen} printer={plugFor} />{/if}
