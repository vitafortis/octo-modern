<script lang="ts">
	import { onMount } from 'svelte';
	import { CircleCheck, CircleX, LoaderCircle, ScanEye, Send } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { printers, toast } from '#lib/client/state.svelte.ts';
	import type { DetectGlobalInfo } from '#lib/detect.ts';

	/** Admins: where Obico's ML API runs and how it reaches octo·modern. */
	let info = $state<DetectGlobalInfo | null>(null);
	let form = $state({ mlApiUrl: '', publicUrl: '', token: '' });
	let clearToken = $state(false);
	let saving = $state(false);
	let testing = $state(false);
	let testPrinter = $state('');
	type Result = { ok: boolean; message?: string; health: { ok: boolean; message: string } | null; roundTrip: { ok: boolean; message: string } | null };
	let result = $state<Result | null>(null);

	function fill(i: DetectGlobalInfo) {
		info = i;
		form = { mlApiUrl: i.mlApiUrl ?? '', publicUrl: i.publicUrl ?? '', token: '' };
		clearToken = false;
	}

	onMount(async () => {
		try {
			fill(await api.get<DetectGlobalInfo>('/api/settings/detection'));
		} catch (err) {
			toast('error', 'Couldn’t load failure detection settings', errorMessage(err));
		}
	});

	async function save(): Promise<boolean> {
		saving = true;
		try {
			const body: Record<string, unknown> = { mlApiUrl: form.mlApiUrl, publicUrl: form.publicUrl };
			if (form.token) body.token = form.token;
			else if (clearToken) body.token = null;
			fill(await api.put<DetectGlobalInfo>('/api/settings/detection', body));
			toast('success', 'Failure detection saved');
			return true;
		} catch (err) {
			toast('error', 'Couldn’t save', errorMessage(err));
			return false;
		} finally {
			saving = false;
		}
	}

	async function test() {
		if (!(await save())) return;
		testing = true;
		result = null;
		try {
			result = await api.post<Result>('/api/settings/detection/test', testPrinter ? { printerId: testPrinter } : {});
		} catch (err) {
			result = { ok: false, message: errorMessage(err), health: null, roundTrip: null };
		} finally {
			testing = false;
		}
	}

	const origin = typeof location !== 'undefined' ? location.origin : '';
</script>

<section class="card p-5" id="failure-detection">
	<h2 class="flex items-center gap-2 text-sm font-semibold"><ScanEye class="size-4 text-primary" />Failure detection</h2>
	<p class="mt-1 max-w-2xl text-xs text-muted-foreground">
		Spaghetti detection with Obico’s ML model, running in your own <code class="font-mono">ml_api</code> container. octo·modern sends it one webcam frame at a time; the container
		downloads each frame from octo·modern through a one-time link, so it needs an address of octo·modern it can reach. Turn detection on per printer, under Camera › Failure detection on its page.
	</p>
	{#if info}
		<div class="mt-4 grid gap-3 md:grid-cols-2">
			<label>
				<span class="label">ML API URL</span>
				<input class="input w-full touch:h-11" placeholder="http://ml_api:3333" bind:value={form.mlApiUrl} data-testid="ml-api-url" />
				<span class="mt-1 block text-xs text-muted-foreground">{info.fromEnv.mlApiUrl ? 'From OCM_ML_API_URL; saving a value overrides it.' : 'Where octo·modern reaches the ml_api container.'}</span>
			</label>
			<div>
				<label for="ml-api-token" class="label">ML API token</label>
				<input id="ml-api-token" class="input w-full touch:h-11" type="password" autocomplete="off" placeholder={info.hasToken ? '•••••• (set)' : 'optional: the container’s ML_API_TOKEN'} bind:value={form.token} data-testid="ml-api-token" />
				<span class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
					{#if info.hasToken && !info.fromEnv.token}
						<label class="flex items-center gap-1.5"><input type="checkbox" bind:checked={clearToken} />Remove the saved token</label>
					{:else if info.fromEnv.token}From OCM_ML_API_TOKEN.{:else}Sent as a Bearer token; stored encrypted.{/if}
				</span>
			</div>
			<label class="md:col-span-2">
				<span class="label">octo·modern’s address, as the ML container sees it</span>
				<input class="input w-full touch:h-11" placeholder="http://octo-modern:3000" bind:value={form.publicUrl} data-testid="detect-public-url" />
				<span class="mt-1 block text-xs text-muted-foreground">
					Usually the compose service name (<code class="font-mono">http://octo-modern:3000</code>), not the address in your browser ({origin}). Only
					<code class="font-mono">/api/detect/frame/&lt;one-time token&gt;</code> is reachable without signing in.
				</span>
			</label>
		</div>
		<div class="mt-4 flex flex-wrap items-center gap-2">
			<button class="btn btn-primary touch:h-11" disabled={saving || testing} onclick={save}>{#if saving}<LoaderCircle class="animate-spin" />{/if}Save</button>
			<select class="input w-full touch:h-11 sm:w-56" aria-label="Test with" bind:value={testPrinter}>
				<option value="">Test with a test card</option>
				{#each printers.list as p (p.id)}<option value={p.id}>Test with {p.name}’s webcam</option>{/each}
			</select>
			<button class="btn btn-secondary touch:h-11" disabled={saving || testing || !form.mlApiUrl || !form.publicUrl} onclick={test} data-testid="detect-test">
				{#if testing}<LoaderCircle class="animate-spin" />{:else}<Send />{/if}Test
			</button>
		</div>
		{#if result}
			<div class="mt-3 space-y-1.5 rounded-xl bg-surface p-3 text-[0.8125rem]" data-testid="detect-test-result">
				{#if result.message}<p class="text-danger">{result.message}</p>{/if}
				{#if result.health}
					<p class="flex items-start gap-1.5">{#if result.health.ok}<CircleCheck class="mt-0.5 size-4 shrink-0 text-success" />{:else}<CircleX class="mt-0.5 size-4 shrink-0 text-danger" />{/if}<span><b class="font-medium">Health check:</b> {result.health.message}</span></p>
				{/if}
				{#if result.roundTrip}
					<p class="flex items-start gap-1.5">{#if result.roundTrip.ok}<CircleCheck class="mt-0.5 size-4 shrink-0 text-success" />{:else}<CircleX class="mt-0.5 size-4 shrink-0 text-danger" />{/if}<span class="min-w-0 break-words"><b class="font-medium">Round trip:</b> {result.roundTrip.message}</span></p>
				{/if}
			</div>
		{/if}
	{/if}
</section>
