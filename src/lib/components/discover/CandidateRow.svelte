<script lang="ts">
	import { ArrowRight, Check, CircleAlert, KeyRound, Plus, RefreshCw, Usb } from '@lucide/svelte';
	import NetworkPathView from './NetworkPathView.svelte';
	import SourceBadge from './SourceBadge.svelte';
	import type { Candidate } from '#lib/discovery.ts';

	let {
		candidate,
		onadd,
		onrelink,
		compact = false
	}: {
		candidate: Candidate;
		/** Starts the add flow with the chosen address. */
		onadd: (c: Candidate, url: string) => void;
		/** Points the matching saved printer at the chosen address. */
		onrelink?: (c: Candidate, url: string) => Promise<void>;
		/** Fewer details (setup wizard). */
		compact?: boolean;
	} = $props();

	const addresses = $derived([{ url: candidate.baseUrl, label: candidate.reachable ? 'answers' : 'best guess', reachable: candidate.reachable }, ...candidate.alternates]);
	let chosen = $state(0);
	const url = $derived(addresses[chosen]?.url ?? candidate.baseUrl);
	const fp = $derived(candidate.fingerprint);
	const running = $derived(!candidate.container || candidate.container.state === 'running');
	const saved = $derived(candidate.saved && !candidate.saved.addressChanged);

	let relinking = $state(false);
	async function relink() {
		if (!onrelink) return;
		relinking = true;
		try {
			await onrelink(candidate, url);
		} finally {
			relinking = false;
		}
	}
</script>

<div data-candidate={candidate.name} class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 px-4 py-3.5 {compact ? '' : 'md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_7rem]'} {saved ? 'bg-success/[0.04]' : ''}">
	<div class="min-w-0">
		<div class="flex min-w-0 items-center gap-2">
			<span
				class="size-2 shrink-0 rounded-full {candidate.reachable ? 'bg-success shadow-[0_0_6px_var(--success)]' : running ? 'bg-warning' : 'bg-muted-foreground/40'}"
				title={candidate.reachable ? 'Answers' : running ? 'Not reachable from octo·modern' : 'Not running'}
			></span>
			<span class="truncate text-[0.8125rem] font-medium" title={candidate.name}>{candidate.name}</span>
		</div>
		<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
			<SourceBadge source={candidate.source} />
			{#if fp.kind === 'moonraker'}
				<span class="badge badge-primary" title={fp.signals.join('\n')}>Klipper · Moonraker{fp.version ? ` ${fp.version}` : ''}</span>
			{:else if fp.confidence === 'confirmed'}
				<span class="badge badge-primary" title={fp.signals.join('\n')}>OctoPrint{fp.version ? ` ${fp.version}` : ''}</span>
			{:else if fp.confidence === 'possible'}
				<span class="badge badge-warning" title={fp.signals.join('\n')}>maybe OctoPrint</span>
			{:else if fp.version}
				<span class="badge" title={fp.signals.join('\n')}>OctoPrint {fp.version}</span>
			{/if}
		</div>
		{#if candidate.container && !compact}
			<p class="mt-1.5 truncate font-mono text-[0.6875rem] text-muted-foreground" title="{candidate.container.image} · {candidate.container.status}">
				{candidate.container.image}{candidate.container.project ? ` · ${candidate.container.project}` : ''}
			</p>
		{/if}
	</div>

	<div class="col-span-2 min-w-0 {compact ? '' : 'md:col-span-1'}">
		{#if !running && !candidate.reachable && !candidate.alternates.length}
			<p class="flex h-8 items-center rounded-lg border border-dashed border-border px-3 text-xs text-muted-foreground">No address while the container is {candidate.container?.state}</p>
		{:else if addresses.length > 1}
			<select class="input h-8 font-mono text-xs" bind:value={chosen} aria-label="Address for {candidate.name}">
				{#each addresses as a, i (a.url)}
					<option value={i}>{a.url} — {a.label}{a.reachable === false ? ' (no answer)' : ''}</option>
				{/each}
			</select>
		{:else}
			<p class="input flex h-8 items-center truncate font-mono text-xs" title={url}>{url}</p>
		{/if}
		<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
			{#if candidate.reachable}
				<span class="badge badge-success"><span class="size-1.5 rounded-full bg-success"></span>reachable</span>
			{:else}
				<span class="badge"><span class="size-1.5 rounded-full bg-muted-foreground/50"></span>{running ? 'not reachable' : candidate.container?.state}</span>
			{/if}
			{#if fp.appkeys}
				<span class="badge" title="Application Keys: approve octo·modern in OctoPrint instead of copying a key"><KeyRound />app keys</span>
			{/if}
			{#each candidate.serial as d (d.host)}
				<span class="badge font-mono" title={d.via === 'privileged' ? 'Privileged container with the host’s /dev' : `${d.host} → ${d.container} (${d.via === 'device' ? '--device' : 'bind mount'})`}>
					<Usb />{d.via === 'privileged' ? 'all of /dev' : d.host.replace(/^\/dev\/serial\/by-id\//, '')}
				</span>
			{/each}
		</div>
		{#if candidate.network && !compact}
			<NetworkPathView path={candidate.network} reachable={candidate.reachable} />
		{/if}
		{#if candidate.saved?.addressChanged}
			<div class="mt-2 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-2 text-[0.6875rem]">
				<p>
					Saved as <a class="font-medium text-primary hover:underline" href="/p/{candidate.saved.id}">{candidate.saved.name}</a>
					on <span class="font-mono">{candidate.saved.baseUrl}</span>{candidate.reachable ? ', but this scan reaches it elsewhere.' : '.'}
				</p>
				{#if onrelink}
					<button type="button" class="btn btn-secondary btn-sm mt-1.5" disabled={relinking} onclick={relink}>
						<RefreshCw class={relinking ? 'animate-spin' : ''} />Use <span class="font-mono">{url}</span><ArrowRight class="opacity-50" />{candidate.saved.name}
					</button>
				{/if}
			</div>
		{/if}
		{#if !compact}
			{#each candidate.notes as note (note)}
				<p class="mt-1.5 flex items-start gap-1 text-[0.6875rem] text-muted-foreground"><CircleAlert class="mt-px size-3 shrink-0" />{note}</p>
			{/each}
		{/if}
	</div>

	<div class="col-start-2 row-start-1 flex justify-end {compact ? '' : 'md:col-start-3'}">
		{#if saved}
			<a class="btn btn-secondary btn-sm text-success hover:text-success" href="/p/{candidate.saved!.id}" title="Saved as {candidate.saved!.name}: open it"><Check />Saved</a>
		{:else}
			<button type="button" class="btn btn-primary btn-sm" onclick={() => onadd(candidate, url)}><Plus />Add</button>
		{/if}
	</div>
</div>
