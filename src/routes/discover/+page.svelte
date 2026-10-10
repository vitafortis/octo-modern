<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Boxes, CircleAlert, Container, Copy, EyeOff, LoaderCircle, Network, Plus, Radar, RefreshCw, ScanSearch, Server, Trash2, Unplug, X } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import CandidateRow from '#lib/components/discover/CandidateRow.svelte';
	import AddDiscovered from '#lib/components/discover/AddDiscovered.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { editor, refreshPrinters, refreshStatuses, toast } from '#lib/client/state.svelte.ts';
	import { joinNetworksSnippet, type ArcaneScan, type Candidate, type DiscoveryConfig, type DockerScan, type NetworkScan, type SelfNetworks } from '#lib/discovery.ts';
	import type { Printer, TestResult } from '#lib/types.ts';

	type Tab = 'docker' | 'arcane' | 'network';
	const initial = page.url.searchParams.get('tab');
	let tab = $state<Tab>(initial === 'arcane' || initial === 'network' ? initial : 'docker');

	let config = $state<DiscoveryConfig | null>(null);
	let docker = $state<DockerScan[] | null>(null);
	let arcane = $state<ArcaneScan[] | null>(null);
	let mdns = $state<NetworkScan | null>(null);
	let subnet = $state<NetworkScan | null>(null);
	let loading = $state({ docker: false, arcane: false, mdns: false, subnet: false });
	let subnetForm = $state({ targets: '', ports: '80, 5000, 443' });
	let subnetError = $state('');
	let adding = $state<{ candidate: Candidate; url: string } | null>(null);
	let hideSaved = $state(false);

	const keep = (c: Candidate) => !hideSaved || !c.saved || c.saved.addressChanged;

	async function scanDocker() {
		loading.docker = true;
		try {
			docker = await api.get<DockerScan[]>('/api/discover/docker');
		} catch (err) {
			toast('error', 'Docker scan failed', errorMessage(err));
		} finally {
			loading.docker = false;
		}
	}

	async function scanArcane() {
		if (!config?.managers.length) return;
		loading.arcane = true;
		try {
			arcane = await api.get<ArcaneScan[]>('/api/discover/arcane');
		} catch (err) {
			toast('error', 'Arcane scan failed', errorMessage(err));
		} finally {
			loading.arcane = false;
		}
	}

	async function scanMdns() {
		loading.mdns = true;
		try {
			mdns = await api.post<NetworkScan>('/api/discover/mdns');
		} catch (err) {
			toast('error', 'mDNS browse failed', errorMessage(err));
		} finally {
			loading.mdns = false;
		}
	}

	async function scanSubnet(e?: SubmitEvent) {
		e?.preventDefault();
		subnetError = '';
		loading.subnet = true;
		try {
			subnet = await api.post<NetworkScan>('/api/discover/subnet', subnetForm);
		} catch (err) {
			subnetError = errorMessage(err);
		} finally {
			loading.subnet = false;
		}
	}

	function rescan() {
		if (tab === 'docker') scanDocker();
		else if (tab === 'arcane') scanArcane();
		else {
			scanMdns();
			if (subnet) scanSubnet();
		}
	}

	onMount(async () => {
		config = await api.get<DiscoveryConfig>('/api/discover/settings');
		subnetForm = { targets: config.settings.subnet.cidr, ports: config.settings.subnet.ports || '80, 5000, 443' };
		scanDocker();
		scanArcane();
		scanMdns();
	});

	// --- adding, relinking ----------------------------------------------------------

	const everyCandidate = () => [
		...(docker ?? []).flatMap((d) => d.candidates),
		...(arcane ?? []).flatMap((a) => a.environments.flatMap((e) => e.candidates)),
		...(mdns?.candidates ?? []),
		...(subnet?.candidates ?? [])
	];

	function onadded(printer: Printer, test: TestResult) {
		const from = adding?.candidate;
		for (const c of everyCandidate()) {
			if (c === from || c.key === from?.key) c.saved = { id: printer.id, name: printer.name, baseUrl: printer.baseUrl, addressChanged: false };
		}
		void refreshPrinters();
		void refreshStatuses();
		toast(
			'success',
			`Added ${printer.name}`,
			test.ok ? `OctoPrint ${test.version}, key of ${test.user}${test.missing.length ? `; missing ${test.missing.join(', ')}` : ''}` : 'Saved without a working connection'
		);
	}

	async function relink(c: Candidate, url: string) {
		try {
			const p = await api.post<Printer>('/api/discover/relink', { printerId: c.saved!.id, baseUrl: url, key: c.key });
			c.saved = { id: p.id, name: p.name, baseUrl: p.baseUrl, addressChanged: false };
			await refreshPrinters();
			toast('success', 'Printer updated', `${p.name} now uses ${p.baseUrl}`);
		} catch (err) {
			toast('error', 'Could not update the printer', errorMessage(err));
		}
	}

	// --- Docker endpoints and Arcane -----------------------------------------------

	let newEndpoint = $state('');
	async function saveEndpoints(dockerHosts: string[]) {
		try {
			config = await api.put<DiscoveryConfig>('/api/discover/settings', { dockerHosts });
			scanDocker();
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		}
	}

	let arcaneForm = $state({ name: 'Arcane', url: '', apiKey: '' });
	let arcaneBusy = $state(false);
	let arcaneError = $state('');
	async function connectArcane(e: SubmitEvent) {
		e.preventDefault();
		arcaneBusy = true;
		arcaneError = '';
		try {
			const r = await api.post<{ environments: number }>('/api/discover/arcane/managers', arcaneForm);
			toast('success', 'Arcane connected', `${r.environments} environment${r.environments === 1 ? '' : 's'}`);
			arcaneForm = { name: 'Arcane', url: '', apiKey: '' };
			config = await api.get<DiscoveryConfig>('/api/discover/settings');
			scanArcane();
		} catch (err) {
			arcaneError = errorMessage(err);
		} finally {
			arcaneBusy = false;
		}
	}
	async function removeArcane(id: string) {
		await api.del(`/api/discover/arcane/managers/${id}`);
		config = await api.get<DiscoveryConfig>('/api/discover/settings');
		arcane = (arcane ?? []).filter((a) => a.manager.id !== id);
	}

	// --- derived ----------------------------------------------------------------------

	const count = (list: Candidate[]) => list.filter(keep).length;
	const dockerCount = $derived(count((docker ?? []).flatMap((d) => d.candidates)));
	const arcaneCount = $derived(count((arcane ?? []).flatMap((a) => a.environments.flatMap((e) => e.candidates))));
	const networkCount = $derived(count([...(mdns?.candidates ?? []), ...(subnet?.candidates ?? [])]));
	const busy = $derived(tab === 'docker' ? loading.docker : tab === 'arcane' ? loading.arcane : loading.mdns || loading.subnet);

	const selfInfo = $derived.by((): SelfNetworks | undefined => {
		const all = tab === 'docker' ? (docker ?? []).map((d) => d.self) : tab === 'arcane' ? (arcane ?? []).flatMap((a) => a.environments.map((e) => e.self)) : [];
		const known = all.filter((x): x is SelfNetworks => !!x);
		return known.find((x) => x.container) ?? known[0];
	});
	const joinable = $derived.by(() => {
		const list = tab === 'docker' ? (docker ?? []).flatMap((d) => d.candidates) : tab === 'arcane' ? (arcane ?? []).flatMap((a) => a.environments.flatMap((e) => e.candidates)) : [];
		const byNet = new Map<string, string[]>();
		for (const c of list) if (!c.reachable && c.network?.via === 'none' && c.network.join) byNet.set(c.network.join, [...(byNet.get(c.network.join) ?? []), c.name]);
		return [...byNet].map(([network, names]) => ({ network, names }));
	});
	const stranded = $derived(joinable.flatMap((j) => j.names));
	let showJoin = $state(false);
</script>

<svelte:head><title>Discover · octo·modern</title></svelte:head>

{#snippet rows(list: Candidate[], empty: string)}
	{@const shown = list.filter(keep)}
	{#if shown.length}
		<div class="card divide-y divide-border overflow-hidden">
			{#each shown as c (c.key)}
				<CandidateRow candidate={c} onadd={(cand, url) => (adding = { candidate: cand, url })} onrelink={relink} />
			{/each}
		</div>
	{:else}
		<div class="card p-6 text-center text-[13px] text-muted-foreground">{list.length ? 'Every OctoPrint found here is already saved.' : empty}</div>
	{/if}
{/snippet}

<div class="h-full overflow-y-auto">
	<PageHeader title="Discover" description="Find OctoPrint servers in Docker, in Arcane and on your network, and add them without copying API keys.">
		{#snippet actions()}
			<button class="btn btn-ghost" onclick={() => (editor.target = 'new')}><Plus />Add manually</button>
			<button class="btn btn-secondary" disabled={busy} onclick={rescan}>
				{#if busy}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}Rescan
			</button>
		{/snippet}
	</PageHeader>

	<div class="px-8 pb-16">
		<div class="mb-5 flex flex-wrap items-center gap-3">
			<div class="inline-flex rounded-lg border border-border bg-surface p-0.5" role="tablist">
				{#each [{ id: 'docker', label: 'Docker', icon: Container, count: dockerCount, busy: loading.docker }, { id: 'arcane', label: 'Arcane', icon: Boxes, count: arcaneCount, busy: loading.arcane }, { id: 'network', label: 'Network', icon: Radar, count: networkCount, busy: loading.mdns || loading.subnet }] as t (t.id)}
					<button
						role="tab"
						aria-selected={tab === t.id}
						class="flex h-7 items-center gap-2 rounded-md px-3 text-[13px] font-medium transition {tab === t.id ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
						onclick={() => (tab = t.id as Tab)}
					>
						<t.icon class="size-3.5" />{t.label}
						{#if t.busy}<LoaderCircle class="size-3 animate-spin opacity-60" />{:else if t.count}<span class="rounded bg-primary-soft px-1.5 text-[11px] text-primary tabular-nums">{t.count}</span>{/if}
					</button>
				{/each}
			</div>
			<button class="btn btn-sm {hideSaved ? 'btn-secondary text-primary' : 'btn-ghost'}" aria-pressed={hideSaved} onclick={() => (hideSaved = !hideSaved)} title="Hide printers that are already saved (moved ones stay visible)">
				<EyeOff />Hide saved
			</button>
		</div>

		{#if selfInfo}
			<div class="mb-3 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
				<Network class="size-3.5" />
				{#if selfInfo.container}
					octo·modern runs as <span class="font-mono text-foreground">{selfInfo.container}</span> on
					{#each selfInfo.networks as n (n)}<span class="rounded-md border border-success/30 bg-success/10 px-1.5 py-px font-mono text-[11px] text-success">{n}</span>{/each}
					<span>· OctoPrint containers on these networks are reachable by name.</span>
				{:else if selfInfo.inContainer}
					octo·modern isn’t one of this host’s containers, so only published ports are reachable from it.
				{:else}
					octo·modern isn’t running in a container; it reaches OctoPrint through published ports and container IPs.
				{/if}
			</div>
		{/if}
		{#if joinable.length}
			<div class="card mb-4 border-warning/30 p-3.5 text-[12px]">
				<div class="flex flex-wrap items-center gap-2">
					<Unplug class="size-4 text-warning" />
					<span>
						<span class="font-medium">{stranded.length === 1 ? stranded[0] : `${stranded.length} OctoPrint containers`}</span>
						{stranded.length === 1 ? 'has' : 'have'} no route from octo·modern. Attaching octo·modern to
						<span class="font-mono">{joinable.map((j) => j.network).join(', ')}</span> would fix that.
					</span>
					<button class="btn btn-secondary btn-sm ml-auto" onclick={() => (showJoin = !showJoin)}>{showJoin ? 'Hide' : 'Show'} compose change</button>
				</div>
				{#if showJoin}
					<div class="relative mt-3">
						<pre class="overflow-x-auto rounded-lg border border-border bg-surface p-3 font-mono text-[11px]">{joinNetworksSnippet(joinable.map((j) => j.network))}</pre>
						<button class="btn btn-ghost btn-icon btn-sm absolute top-1.5 right-1.5" title="Copy" onclick={() => navigator.clipboard.writeText(joinNetworksSnippet(joinable.map((j) => j.network))).then(() => toast('success', 'Copied'))}><Copy /></button>
					</div>
				{/if}
			</div>
		{/if}

		{#if tab === 'docker'}
			{#if !docker}
				<div class="card flex items-center gap-3 p-6 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />Inspecting containers…</div>
			{:else}
				<div class="space-y-6">
					{#if !docker.length}
						<div class="card p-6 text-[13px] text-muted-foreground">
							<p class="flex items-center gap-2 font-medium text-foreground"><Server class="size-4 text-primary" />No Docker endpoint configured</p>
							<p class="mt-1.5">
								Run the read-only <span class="font-mono">docker-socket-proxy</span> next to octo·modern and set
								<span class="font-mono">OCM_DOCKER_HOSTS=tcp://docker-proxy:2375</span> (see the commented service in <span class="font-mono">compose.yaml</span>), or add an endpoint below.
							</p>
						</div>
					{/if}
					{#each docker as d (d.endpoint)}
						<section>
							<div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<Server class="size-3.5" /><span class="font-mono text-foreground">{d.endpoint}</span>
								{#if d.inspected !== undefined}<span>· {d.inspected} container{d.inspected === 1 ? '' : 's'} inspected, {d.candidates.length} OctoPrint</span>{/if}
							</div>
							{#if d.error}
								<div class="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-xs"><CircleAlert class="mt-px size-4 shrink-0 text-danger" />{d.error}</div>
							{:else}
								{@render rows(d.candidates, 'No OctoPrint containers on this host.')}
							{/if}
						</section>
					{/each}
					<details class="card px-4 py-3 text-[13px]">
						<summary class="cursor-pointer text-[12px] text-muted-foreground select-none hover:text-foreground">Docker endpoints</summary>
						<div class="mt-3 flex flex-wrap gap-1.5">
							{#each config?.envDockerHosts ?? [] as h (h)}<span class="badge h-6 font-mono" title="From OCM_DOCKER_HOSTS">{h}</span>{/each}
							{#each config?.settings.dockerHosts ?? [] as h (h)}
								<span class="badge h-6 pr-0.5 font-mono">{h}<button class="rounded p-0.5 hover:bg-accent" aria-label="Remove {h}" onclick={() => saveEndpoints(config!.settings.dockerHosts.filter((x) => x !== h))}><X /></button></span>
							{/each}
						</div>
						<form class="mt-3 flex gap-2" onsubmit={(e) => (e.preventDefault(), saveEndpoints([...(config?.settings.dockerHosts ?? []), newEndpoint.trim()]), (newEndpoint = ''))}>
							<input class="input h-8 font-mono text-xs" placeholder="tcp://nas.lan:2375 (a read-only socket proxy)" bind:value={newEndpoint} />
							<button class="btn btn-secondary btn-sm h-8" disabled={!newEndpoint.trim()}><Plus />Add</button>
						</form>
						<p class="mt-2 text-[11px] text-muted-foreground">Only <span class="font-mono">GET /containers</span> is used. Point this at a docker-socket-proxy with <span class="font-mono">CONTAINERS=1</span>, never at a writable Docker API.</p>
					</details>
				</div>
			{/if}
		{:else if tab === 'arcane'}
			<div class="space-y-6">
				{#each arcane ?? [] as a (a.manager.id)}
					<section class="space-y-3">
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<Boxes class="size-3.5" /><span class="font-medium text-foreground">{a.manager.name}</span><span class="font-mono">{a.manager.url}</span>
							{#if a.error}<span class="badge badge-danger">{a.error}</span>{/if}
						</div>
						{#each a.environments as env (env.id)}
							<div>
								<div class="mb-2 flex items-center gap-2 pl-1 text-xs text-muted-foreground">
									<Server class="size-3.5" />{env.name}<span class="font-mono opacity-70">{env.host}</span>
									{#if env.inspected !== undefined}<span>· {env.inspected} container{env.inspected === 1 ? '' : 's'}</span>{/if}
								</div>
								{#if env.error}
									<p class="flex items-center gap-1.5 pl-1 text-[12px] text-warning"><CircleAlert class="size-3.5" />{env.error}</p>
								{:else}
									{@render rows(env.candidates, 'No OctoPrint containers in this environment.')}
								{/if}
							</div>
						{/each}
					</section>
				{/each}
				{#if loading.arcane && !arcane}
					<div class="card flex items-center gap-3 p-6 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />Reading containers from Arcane…</div>
				{/if}

				<div class="card p-5">
					<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Boxes class="size-4 text-primary" />{config?.managers.length ? 'Arcane instances' : 'Read containers straight from Arcane'}</h2>
					<p class="mt-1 text-[12px] text-muted-foreground">
						In Arcane, open <b class="font-medium text-foreground">Settings → API Keys</b> and create a key with read-only permissions:
						<span class="font-mono">environments:list</span>, <span class="font-mono">containers:list</span>, <span class="font-mono">containers:read</span>
						(<span class="font-mono">projects:list</span> and <span class="font-mono">projects:read</span> are harmless; pg·modern’s key works too). Stored encrypted.
					</p>
					{#if config?.managers.length}
						<div class="mt-3 divide-y divide-border rounded-lg border border-border">
							{#each config.managers as m (m.id)}
								<div class="flex items-center gap-3 px-3 py-2 text-[13px]">
									<span class="font-medium">{m.name}</span><span class="truncate font-mono text-xs text-muted-foreground">{m.url}</span>
									{#if m.fromEnv}<span class="badge ml-auto">OCM_ARCANE_URL</span>{:else}<button class="btn btn-ghost btn-icon btn-sm ml-auto" title="Disconnect" onclick={() => removeArcane(m.id)}><Trash2 /></button>{/if}
								</div>
							{/each}
						</div>
					{/if}
					<form class="mt-4 grid gap-2 sm:grid-cols-[0.7fr_1.3fr_1.3fr_auto]" onsubmit={connectArcane}>
						<input class="input h-8 text-[13px]" placeholder="Name" aria-label="Arcane name" bind:value={arcaneForm.name} />
						<input class="input h-8 font-mono text-xs" placeholder="http://arcane.lan:3552" aria-label="Arcane URL" required bind:value={arcaneForm.url} />
						<input class="input h-8 font-mono text-xs" type="password" autocomplete="off" placeholder="API key" aria-label="Arcane API key" required bind:value={arcaneForm.apiKey} />
						<button class="btn btn-primary btn-sm h-8" disabled={arcaneBusy}>{#if arcaneBusy}<LoaderCircle class="animate-spin" />{:else}<Plus />{/if}Connect</button>
					</form>
					{#if arcaneError}<p class="mt-2 text-xs text-danger">{arcaneError}</p>{/if}
				</div>
			</div>
		{:else}
			<div class="space-y-6">
				<section>
					<div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<Radar class="size-3.5" /><span class="font-medium text-foreground">mDNS</span>
						<span class="font-mono">_octoprint._tcp.local</span>
						{#if mdns}<span>· {mdns.probed} responder{mdns.probed === 1 ? '' : 's'} in {(mdns.durationMs / 1000).toFixed(1)} s</span>{/if}
						<button class="btn btn-ghost btn-sm ml-auto" disabled={loading.mdns} onclick={scanMdns}>{#if loading.mdns}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}Browse again</button>
					</div>
					{#if mdns?.error}
						<div class="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-xs"><CircleAlert class="mt-px size-4 shrink-0 text-danger" />{mdns.error}</div>
					{:else if mdns}
						{@render rows(mdns.candidates, 'No OctoPrint answered. mDNS only works when octo·modern shares the LAN segment: run it with network_mode: host or on a macvlan network, or use a subnet scan below.')}
					{:else}
						<div class="card flex items-center gap-3 p-6 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />Listening for OctoPrint announcements…</div>
					{/if}
				</section>

				<section>
					<div class="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><ScanSearch class="size-3.5" /><span class="font-medium text-foreground">Subnet scan</span></div>
					<form class="card p-4" onsubmit={scanSubnet}>
						<div class="grid gap-3 sm:grid-cols-[1.6fr_1fr_auto] sm:items-end">
							<div>
								<label class="label" for="sn-targets">Addresses</label>
								<input id="sn-targets" class="input h-8 font-mono text-xs" placeholder="192.168.1.0/24, 10.0.0.20-40, octopi.lan" required bind:value={subnetForm.targets} />
							</div>
							<div>
								<label class="label" for="sn-ports">Ports</label>
								<input id="sn-ports" class="input h-8 font-mono text-xs" placeholder="80, 5000, 443" bind:value={subnetForm.ports} />
							</div>
							<button class="btn btn-primary h-8" disabled={loading.subnet || !subnetForm.targets.trim()}>{#if loading.subnet}<LoaderCircle class="animate-spin" />Scanning…{:else}<ScanSearch />Scan{/if}</button>
						</div>
						<p class="mt-2.5 text-[11px] text-muted-foreground">
							For OctoPi and other installs outside Docker. octo·modern opens a TCP connection to each address and port (128 at a time, 0.7 s timeout), then asks whatever answers
							whether it’s OctoPrint, without a key. Up to 4096 addresses (a /20).
						</p>
						{#if subnetError}<p class="mt-2 flex items-center gap-1.5 text-xs text-danger"><CircleAlert class="size-3.5" />{subnetError}</p>{/if}
					</form>
					{#if subnet}
						<p class="mt-3 mb-2 text-[11px] text-muted-foreground">Probed {subnet.probed} address/port pairs ({subnet.scope}) in {(subnet.durationMs / 1000).toFixed(1)} s.</p>
						{@render rows(subnet.candidates, 'No OctoPrint found in that range.')}
					{/if}
				</section>
			</div>
		{/if}
	</div>
</div>

<AddDiscovered bind:target={adding} {onadded} />
