<script lang="ts">
	import { onMount } from 'svelte';
	import { LoaderCircle, Radar, RefreshCw } from '@lucide/svelte';
	import CandidateRow from './CandidateRow.svelte';
	import AddDiscovered from './AddDiscovered.svelte';
	import { api } from '#lib/client/api.ts';
	import { addressKey, type Candidate, type DockerScan, type NetworkScan } from '#lib/discovery.ts';
	import type { Printer, TestResult } from '#lib/types.ts';

	/** Docker and mDNS discovery in one list, for the setup wizard. */
	let { onadded }: { onadded: (printer: Printer, test: TestResult) => void } = $props();

	let candidates = $state<Candidate[]>([]);
	let scanning = $state(false);
	let hidden = $state(0);
	let adding = $state<{ candidate: Candidate; url: string } | null>(null);

	async function scan() {
		scanning = true;
		const [docker, mdns] = await Promise.all([
			api.get<DockerScan[]>('/api/discover/docker').catch(() => [] as DockerScan[]),
			api.post<NetworkScan>('/api/discover/mdns').catch(() => null)
		]);
		const all = [...docker.flatMap((d) => d.candidates), ...(mdns?.candidates ?? [])];
		// The same server seen by Docker and mDNS is listed once.
		const seen = new Set<string>();
		candidates = all.filter((c) => {
			const keys = [c.baseUrl, ...c.alternates.filter((a) => a.reachable).map((a) => a.url)].map(addressKey);
			if (keys.some((k) => seen.has(k))) return false;
			keys.forEach((k) => seen.add(k));
			return c.fingerprint.confidence !== 'none' || c.container;
		});
		// Reachable ones first; the rest are counted, and Discover explains them after setup.
		hidden = candidates.filter((c) => !c.reachable).length;
		candidates = candidates.filter((c) => c.reachable);
		scanning = false;
	}

	onMount(scan);
</script>

<div class="rounded-xl border border-border bg-surface/60">
	<div class="flex items-center gap-2 px-4 py-2.5 text-xs">
		<Radar class="size-3.5 text-primary" />
		<span class="font-medium">Found on this host and network</span>
		{#if scanning}
			<span class="ml-auto flex items-center gap-1.5 text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" />Looking in Docker and mDNS…</span>
		{:else}
			<button type="button" class="btn btn-ghost btn-sm ml-auto" onclick={scan}><RefreshCw />Look again</button>
		{/if}
	</div>
	{#if candidates.length}
		<div class="divide-y divide-border border-t border-border">
			{#each candidates as c (c.key)}
				<CandidateRow candidate={c} compact onadd={(cand, url) => (adding = { candidate: cand, url })} />
			{/each}
		</div>
		{#if hidden}
			<p class="border-t border-border px-4 py-2.5 text-[0.6875rem] text-muted-foreground">
				{hidden} more {hidden === 1 ? 'isn’t' : 'aren’t'} reachable from octo·modern; <b class="font-medium text-foreground">Discover</b> shows why after setup.
			</p>
		{/if}
	{:else if !scanning}
		<p class="border-t border-border px-4 py-3 text-xs text-muted-foreground">
			Nothing found automatically. Enter the address below; later, <b class="font-medium text-foreground">Discover</b> can also scan a subnet or read Arcane.
		</p>
	{/if}
</div>

<AddDiscovered bind:target={adding} {onadded} />
