<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { ArrowRight, Check, CircleAlert, CircleCheck, LoaderCircle, Printer, UserRound, X, Zap } from '@lucide/svelte';
	import Logo from '#lib/components/Logo.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import type { Printer as PrinterT, TestResult } from '#lib/types.ts';

	let step = $state<1 | 2 | 3>(1);
	let busy = $state(false);
	let error = $state('');

	// Step 1 — the first admin.
	let name = $state('');
	let email = $state('');
	let password = $state('');
	let repeat = $state('');

	async function createAdmin(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (password !== repeat) {
			error = 'Passwords do not match';
			return;
		}
		busy = true;
		try {
			await api.post('/api/auth/setup', { name, email, password });
			step = 2;
		} catch (err) {
			error = errorMessage(err);
		} finally {
			busy = false;
		}
	}

	// Step 2 — the first printer (optional).
	let server = $state({ name: '', baseUrl: '', apiKey: '' });
	let test = $state<TestResult | null>(null);
	let added = $state<PrinterT | null>(null);

	async function runTest() {
		busy = true;
		test = null;
		try {
			test = await api.post<TestResult>('/api/printers/test', { ...server, verifyTls: true });
		} catch (err) {
			test = { ok: false, error: { message: errorMessage(err) } };
		} finally {
			busy = false;
		}
	}

	async function addPrinter(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			added = await api.post<PrinterT>('/api/printers', { ...server, verifyTls: true });
			step = 3;
		} catch (err) {
			error = errorMessage(err);
		} finally {
			busy = false;
		}
	}

	async function finish() {
		await invalidateAll();
		goto(added ? `/p/${added.id}` : '/');
	}

	const steps = [
		{ n: 1, label: 'Admin account' },
		{ n: 2, label: 'First printer' },
		{ n: 3, label: 'Done' }
	];
</script>

<svelte:head><title>Set up · octo·modern</title></svelte:head>

<div class="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
	<div class="dot-grid mask-fade pointer-events-none absolute inset-0 opacity-70"></div>
	<div class="glow-top pointer-events-none absolute inset-x-0 top-0 h-[480px]"></div>

	<div class="relative w-full max-w-lg">
		<div class="mb-6 flex flex-col items-center text-center">
			<Logo size={44} />
			<h1 class="mt-4 text-lg font-semibold tracking-tight">Welcome to octo·modern</h1>
			<p class="mt-1 text-[13px] text-muted-foreground">Two minutes and you're watching your printers.</p>
		</div>

		<ol class="mb-5 flex items-center justify-center gap-2 text-xs">
			{#each steps as s, i (s.n)}
				<li class="flex items-center gap-2 {step >= s.n ? 'text-foreground' : 'text-muted-foreground'}">
					<span class="grid size-5 place-items-center rounded-full text-[10px] font-semibold {step > s.n ? 'bg-primary text-primary-foreground' : step === s.n ? 'bg-primary-soft text-primary ring-1 ring-primary/50' : 'bg-muted'}">
						{#if step > s.n}<Check class="size-3" />{:else}{s.n}{/if}
					</span>
					{s.label}
				</li>
				{#if i < steps.length - 1}<span class="h-px w-8 bg-border"></span>{/if}
			{/each}
		</ol>

		<div class="card p-7 shadow-surface-lg">
			{#if step === 1}
				<form onsubmit={createAdmin}>
					<h2 class="flex items-center gap-2 text-[15px] font-semibold"><UserRound class="size-4 text-primary" />Create the admin account</h2>
					<p class="mt-1 text-xs text-muted-foreground">This account manages printers, users and settings. Add operators and viewers later, or turn on single sign-on.</p>
					<div class="mt-5 grid gap-3">
						<div>
							<label class="label" for="s-name">Your name</label>
							<!-- svelte-ignore a11y_autofocus -->
							<input id="s-name" class="input" autocomplete="name" autofocus bind:value={name} />
						</div>
						<div>
							<label class="label" for="s-email">Email</label>
							<input id="s-email" class="input" type="email" autocomplete="email" required bind:value={email} />
						</div>
						<div class="grid grid-cols-2 gap-3">
							<div>
								<label class="label" for="s-pw">Password</label>
								<input id="s-pw" class="input" type="password" autocomplete="new-password" minlength="8" required bind:value={password} />
							</div>
							<div>
								<label class="label" for="s-pw2">Repeat password</label>
								<input id="s-pw2" class="input" type="password" autocomplete="new-password" minlength="8" required bind:value={repeat} />
							</div>
						</div>
					</div>
					{#if error}<p class="mt-3 text-xs text-danger">{error}</p>{/if}
					<button class="btn btn-primary mt-6 h-9 w-full" disabled={busy}>
						{#if busy}<LoaderCircle class="animate-spin" />{/if}Create account<ArrowRight />
					</button>
				</form>
			{:else if step === 2}
				<form onsubmit={addPrinter}>
					<h2 class="flex items-center gap-2 text-[15px] font-semibold"><Printer class="size-4 text-primary" />Add your first printer</h2>
					<p class="mt-1 text-xs text-muted-foreground">
						The OctoPrint URL and an API key: in OctoPrint, open <b class="font-medium text-foreground">Settings → Application Keys</b> and generate one, or copy your user's key from <b class="font-medium text-foreground">User Settings → API key</b>.
					</p>
					<div class="mt-5 grid gap-3">
						<div class="grid grid-cols-[1fr_1.4fr] gap-3">
							<div>
								<label class="label" for="s-pname">Name</label>
								<input id="s-pname" class="input" placeholder="Prusa MK4" bind:value={server.name} />
							</div>
							<div>
								<label class="label" for="s-url">OctoPrint URL</label>
								<input id="s-url" class="input font-mono text-xs" required placeholder="http://192.168.1.50" bind:value={server.baseUrl} oninput={() => (test = null)} />
							</div>
						</div>
						<div>
							<label class="label" for="s-key">API key</label>
							<input id="s-key" class="input font-mono text-xs" type="password" autocomplete="off" required bind:value={server.apiKey} oninput={() => (test = null)} />
						</div>
					</div>
					{#if test}
						<p class="mt-3 flex items-start gap-1.5 text-xs {test.ok ? 'text-success' : 'text-danger'}">
							{#if test.ok}<CircleCheck class="mt-px size-3.5 shrink-0" />OctoPrint {test.version}, key of {test.user}.{:else}<CircleAlert class="mt-px size-3.5 shrink-0" /><span>{test.error.message}{#if test.error.hint}<span class="block text-muted-foreground">{test.error.hint}</span>{/if}</span>{/if}
						</p>
					{/if}
					{#if error}<p class="mt-3 text-xs text-danger">{error}</p>{/if}
					<div class="mt-6 flex items-center gap-2">
						<button type="button" class="btn btn-ghost mr-auto" onclick={() => (step = 3)}><X />Skip</button>
						<button type="button" class="btn btn-secondary" disabled={busy || !server.baseUrl || !server.apiKey} onclick={runTest}><Zap />Test</button>
						<button class="btn btn-primary" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Add printer<ArrowRight /></button>
					</div>
				</form>
			{:else}
				<div class="text-center">
					<div class="mx-auto grid size-12 place-items-center rounded-full bg-success/10 text-success"><Check class="size-6" /></div>
					<h2 class="mt-4 text-[15px] font-semibold">You're set up</h2>
					<p class="mt-1.5 text-xs text-muted-foreground">
						{added ? `${added.name} is ready. Add more printers, users and single sign-on any time.` : 'Add a printer from the sidebar whenever you’re ready.'}
					</p>
					<button class="btn btn-primary mt-6 h-9 w-full" onclick={finish}><Printer />{added ? `Open ${added.name}` : 'Open octo·modern'}</button>
				</div>
			{/if}
		</div>
	</div>
</div>
