<script lang="ts">
	import { Cable, ChevronDown, LoaderCircle, Plug, Unplug } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { connectPrinter, disconnectPrinter } from '#lib/client/actions.ts';
	import type { LivePrinter } from '#lib/client/live.svelte.ts';
	import { jobActive } from '#lib/printer.ts';

	/** Connect (with port / baud rate / profile from OctoPrint) or disconnect the printer. */
	let { live, canControl }: { live: LivePrinter; canControl: boolean } = $props();

	type Info = {
		current: { state: string; port: string | null; baudrate: number | null; printerProfile: string | null };
		options: { ports: string[]; baudrates: number[]; printerProfiles: { id: string; name: string }[]; portPreference: string | null; baudratePreference: number | null; printerProfilePreference: string | null };
	};

	let open = $state(false);
	let info = $state<Info | null>(null);
	let error = $state('');
	let busy = $state(false);
	let form = $state({ port: 'AUTO', baudrate: 0, printerProfile: '' });
	let root = $state<HTMLElement>();

	const s = $derived(live.snapshot);
	const connected = $derived(!['offline', 'disconnected', 'unknown', 'error'].includes(s.state));

	async function load() {
		error = '';
		try {
			info = await api.get<Info>(`/api/printers/${live.id}/connection`);
			const o = info.options;
			form = {
				port: o.portPreference && o.ports.includes(o.portPreference) ? o.portPreference : 'AUTO',
				baudrate: o.baudratePreference ?? 0,
				printerProfile: o.printerProfilePreference ?? o.printerProfiles[0]?.id ?? ''
			};
		} catch (err) {
			error = errorMessage(err);
		}
	}

	async function toggle() {
		open = !open;
		if (open) await load();
	}

	async function connect(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = await connectPrinter(live.id, { port: form.port, baudrate: Number(form.baudrate) || undefined, printerProfile: form.printerProfile || undefined });
		busy = false;
		if (ok) open = false;
	}

	async function disconnect() {
		busy = true;
		await disconnectPrinter(live.id, jobActive(s.state));
		busy = false;
	}

	function onwindowclick(e: MouseEvent) {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onclick={onwindowclick} />

{#if canControl && s.state !== 'offline'}
	<div class="relative" bind:this={root}>
		{#if connected}
			<button class="btn btn-secondary btn-sm" disabled={busy} onclick={disconnect} title="Disconnect the printer from OctoPrint"><Unplug />Disconnect</button>
		{:else}
			<button class="btn btn-primary btn-sm" disabled={busy || s.state === 'connecting'} onclick={toggle} aria-expanded={open}>
				{#if s.state === 'connecting'}<LoaderCircle class="animate-spin" />Connecting…{:else}<Plug />Connect<ChevronDown />{/if}
			</button>
			{#if open}
				<form class="card absolute top-full right-0 z-30 mt-1.5 w-72 space-y-3 p-3 shadow-surface-lg" onsubmit={connect}>
					<p class="flex items-center gap-2 text-[13px] font-medium"><Cable class="size-4 text-primary" />Connect printer</p>
					{#if error}
						<p class="text-xs text-danger">{error}</p>
					{:else if !info}
						<p class="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" />Asking OctoPrint for ports…</p>
					{:else}
						<div>
							<label class="label" for="c-port">Serial port</label>
							<select id="c-port" class="input h-8 text-xs" bind:value={form.port}>
								<option value="AUTO">Auto-detect</option>
								{#each info.options.ports as p (p)}<option value={p}>{p}</option>{/each}
							</select>
						</div>
						<div>
							<label class="label" for="c-baud">Baud rate</label>
							<select id="c-baud" class="input h-8 text-xs" bind:value={form.baudrate}>
								<option value={0}>Auto-detect</option>
								{#each info.options.baudrates as b (b)}<option value={b}>{b}</option>{/each}
							</select>
						</div>
						<div>
							<label class="label" for="c-prof">Printer profile</label>
							<select id="c-prof" class="input h-8 text-xs" bind:value={form.printerProfile}>
								{#each info.options.printerProfiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
							</select>
						</div>
						<button class="btn btn-primary btn-sm w-full" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Connect</button>
					{/if}
				</form>
			{/if}
		{/if}
	</div>
{/if}
