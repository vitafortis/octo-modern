<script lang="ts">
	/**
	 * Care › Plugins & updates (OctoPrint printers, admins): OctoPrint's version and the updates on
	 * offer, the installed plugins (search, enable/disable, uninstall), the plugin repository
	 * (search, one-click install, or install from a URL), restarting OctoPrint, and the live log
	 * of whatever is running. The server refuses changes while printing and asks before anything
	 * drastic (act()'s confirm-and-retry).
	 */
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import {
		ArrowRight,
		CircleCheck,
		Download,
		ExternalLink,
		LoaderCircle,
		PackagePlus,
		Power,
		Puzzle,
		RefreshCw,
		RotateCcw,
		Search,
		ShieldAlert,
		Star,
		Trash2,
		TriangleAlert,
		X
	} from '@lucide/svelte';
	import Segmented from '../Segmented.svelte';
	import Switch from '../Switch.svelte';
	import { act } from '#lib/client/actions.ts';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { pluginsApi, type PluginsData } from '#lib/client/plugins.ts';
	import { confirmWithOption, editor, toast } from '#lib/client/state.svelte.ts';
	import {
		availableUpdates,
		effectivelyEnabled,
		filterPlugins,
		searchRepository,
		toggleBlocked,
		toggleCommand,
		uninstallBlocked,
		updateBlocked,
		type InstalledPlugin,
		type PluginFilter,
		type PluginOp,
		type RepoPlugin,
		type Repository,
		type UpdateCheck
	} from '#lib/plugins.ts';
	import { jobActive } from '#lib/printer.ts';
	import type { TabProps } from './tabs.ts';

	let { printer, live }: TabProps = $props();

	let data = $state<PluginsData | null>(null);
	let error = $state('');
	let check = $state<UpdateCheck | null>(null);
	let checkError = $state('');
	let checking = $state(false);
	let repo = $state<Repository | null>(null);
	let repoError = $state('');
	let repoLoading = $state(false);
	let pane = $state<'installed' | 'repository' | 'updates'>('installed');
	let query = $state('');
	let filter = $state<PluginFilter>('all');
	let repoQuery = $state('');
	let archiveUrl = $state('');
	let op = $state<PluginOp | null>(null);
	let dismissedOp = $state<number | null>(null);
	/** Plugin keys with a toggle on its way. */
	let toggling = $state<Record<string, boolean>>({});

	const url = $derived(pluginsApi.url(printer.id));

	async function load() {
		try {
			const d = await pluginsApi.load(printer.id);
			data = d;
			error = '';
			if (d.op && (!op || d.op.id >= op.id)) op = d.op;
		} catch (err) {
			// While OctoPrint restarts, keep what we have.
			if (!data) error = errorMessage(err);
		}
	}

	async function loadUpdates(force = false) {
		checking = true;
		try {
			check = await pluginsApi.updates(printer.id, force);
			checkError = '';
			if (force) void invalidateAll();
		} catch (err) {
			checkError = errorMessage(err);
		} finally {
			checking = false;
		}
	}

	async function loadRepo(refresh = false) {
		repoLoading = true;
		try {
			repo = await pluginsApi.repository(printer.id, refresh);
			repoError = '';
		} catch (err) {
			repoError = errorMessage(err);
		} finally {
			repoLoading = false;
		}
	}

	onMount(() => {
		void load().then(() => {
			if (data?.access === 'ok') void loadUpdates();
		});
	});

	$effect(() => {
		if (pane === 'repository' && !repo && !repoLoading && data?.access === 'ok') void loadRepo();
	});

	// While something runs: follow its log, then refresh everything once it ends.
	const running = $derived(!!op && !op.endedAt);
	$effect(() => {
		if (!running) return;
		const t = setInterval(async () => {
			try {
				const r = await pluginsApi.op(printer.id);
				if (!r.op) return;
				const ended = !!r.op.endedAt && !op?.endedAt;
				op = r.op;
				if (ended) await settled(r.op);
			} catch {
				// octo·modern itself unreachable for a moment: keep polling.
			}
		}, 1000);
		return () => clearInterval(t);
	});

	async function settled(o: PluginOp) {
		const what = { install: 'Install', uninstall: 'Uninstall', enable: 'Enable', disable: 'Disable', update: 'Update', restart: 'Restart' }[o.kind];
		if (o.phase === 'done') toast('success', o.message ?? `${what} done`, o.needsRestart ? 'Restart OctoPrint to finish.' : undefined);
		else toast('error', `${what} failed`, o.message ?? undefined);
		await load();
		if (o.kind === 'update' || o.kind === 'restart' || o.kind === 'install') await loadUpdates();
		void invalidateAll();
	}

	async function followOp() {
		try {
			const r = await pluginsApi.op(printer.id);
			if (r.op) {
				op = r.op;
				if (r.op.endedAt) await settled(r.op);
			}
		} catch {}
	}

	// --- actions ------------------------------------------------------------------------------

	async function toggle(p: InstalledPlugin) {
		const command = toggleCommand(p);
		toggling[p.key] = true;
		try {
			const r = await api.post<{ needsRestart: boolean }>(url, { action: command, plugin: p.key });
			toast('success', `${p.name} ${command === 'enable' ? 'enabled' : 'disabled'}`, r.needsRestart ? 'Restart OctoPrint to finish.' : undefined);
			await load();
		} catch (err) {
			toast('error', `Could not ${command} ${p.name}`, errorMessage(err));
			await load();
		} finally {
			delete toggling[p.key];
		}
	}

	async function uninstall(p: InstalledPlugin) {
		const r = await confirmWithOption({
			title: `Uninstall ${p.name}?`,
			body: 'It’s removed from OctoPrint. OctoPrint may need a restart afterwards.',
			detail: `${p.key}${p.version ? ` ${p.version}` : ''}`,
			confirmLabel: 'Uninstall',
			danger: true,
			option: { label: 'Also delete its settings and data', hint: 'A reinstall then starts fresh.' }
		});
		if (!r.ok) return;
		const ok = await act(url, { action: 'uninstall', plugin: p.key, cleanup: r.option, confirm: true }, { failed: `Could not uninstall ${p.name}` });
		if (ok) await followOp();
		else await load();
	}

	async function install(entry: RepoPlugin) {
		const ok = await act(url, { action: 'install', plugin: entry.id }, { failed: `Could not install ${entry.title}` });
		if (ok) await followOp();
	}

	async function installUrl(e: SubmitEvent) {
		e.preventDefault();
		const ok = await act(url, { action: 'install', url: archiveUrl.trim() }, { failed: 'Could not install the plugin' });
		if (ok) {
			archiveUrl = '';
			await followOp();
		}
	}

	async function update(targets: string[] | 'all') {
		const ok = await act(url, { action: 'update', targets }, { failed: 'Could not start the update' });
		if (ok) await followOp();
	}

	async function restart() {
		const ok = await act(url, { action: 'restart' }, { failed: 'Could not restart OctoPrint' });
		if (ok) await followOp();
	}

	// --- view ---------------------------------------------------------------------------------

	const ok = $derived(data?.access === 'ok' ? data : null);
	const printing = $derived(jobActive(live.snapshot.state) || !!ok?.printing);
	const plugins = $derived(ok?.plugins ?? []);
	const shown = $derived(filterPlugins(plugins, query, filter));
	const installedKeys = $derived(new Set(plugins.map((p) => p.key)));
	const results = $derived(repo ? searchRepository(repo.plugins, repoQuery, repoQuery ? 60 : 30) : []);
	const updates = $derived(availableUpdates(check));
	const octo = $derived(check?.octoprint ?? null);
	const octoUpdate = $derived(octo?.updateAvailable ? octo : null);
	const pluginUpdates = $derived(updates.filter((t) => t.key !== 'octoprint'));
	const busy = $derived(running || printing);
	const busyHint = $derived(running ? 'Wait for the running action to finish' : printing ? 'Not while printing' : '');
	const showOp = $derived(!!op && op.id !== dismissedOp && (!op.endedAt || Date.now() - Date.parse(op.endedAt) < 30 * 60_000));
	const thirdParty = $derived(plugins.filter((p) => !p.bundled).length);
	const restartHint = $derived(
		ok?.restartCommand === false ? 'OctoPrint has no restart command (Settings → Server → Commands)' : busyHint || 'Restart the OctoPrint server'
	);

	const FILTERS: { id: PluginFilter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'thirdparty', label: 'Third-party' },
		{ id: 'bundled', label: 'Bundled' },
		{ id: 'disabled', label: 'Disabled' },
		{ id: 'pending', label: 'Pending restart' }
	];
	const OP_TITLE: Record<PluginOp['kind'], string> = { install: 'Installing', uninstall: 'Uninstalling', enable: 'Enabling', disable: 'Disabling', update: 'Updating', restart: 'Restarting' };

	let logBox = $state<HTMLElement | null>(null);
	$effect(() => {
		void op?.log.length;
		if (logBox) logBox.scrollTop = logBox.scrollHeight;
	});

	const fmtNum = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
	const STREAM: Record<string, string> = { stderr: 'text-danger', message: 'text-foreground', call: 'text-primary', stdout: 'text-muted-foreground' };
</script>

{#snippet pending(p: InstalledPlugin)}
	{#if p.pendingInstall}<span class="badge badge-warning">installed · restart</span>{/if}
	{#if p.pendingUninstall}<span class="badge badge-warning">uninstalled · restart</span>{/if}
	{#if p.pendingEnable}<span class="badge badge-warning">enabled · restart</span>{/if}
	{#if p.pendingDisable}<span class="badge badge-warning">disabled · restart</span>{/if}
{/snippet}

<div class="mx-auto max-w-6xl space-y-5" data-testid="plugins-tab">
	{#if error}
		<div class="card px-4 py-6 text-center text-xs text-danger">{error}</div>
	{:else if !data}
		<div class="card flex items-center justify-center gap-2 px-4 py-10 text-xs text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />Asking OctoPrint…</div>
	{:else if data.access === 'forbidden'}
		<div class="card relative overflow-hidden px-6 py-10 text-center" data-testid="plugins-forbidden">
			<div class="dot-grid mask-fade pointer-events-none absolute inset-0"></div>
			<div class="relative mx-auto max-w-lg">
				<div class="mx-auto grid size-11 place-items-center rounded-xl bg-warning/10 text-warning"><ShieldAlert class="size-5" /></div>
				<h3 class="mt-4 text-[0.9375rem] font-semibold tracking-tight">{data.message}</h3>
				<p class="mt-1.5 text-[0.8125rem] text-muted-foreground">{data.hint ?? 'Managing plugins and updates needs an OctoPrint admin’s API key.'}</p>
				<button class="btn btn-primary btn-sm mt-4" onclick={() => (editor.target = printer)}>Change the API key</button>
			</div>
		</div>
	{:else if ok}
		<!-- Header -->
		<div class="flex flex-wrap items-center gap-3">
			<div class="min-w-0 flex-1">
				<h2 class="text-[0.9375rem] font-semibold tracking-tight">Plugins & updates</h2>
				<p class="text-xs text-muted-foreground">
					{plugins.length} plugins · {thirdParty} third-party{#if ok.safeMode}{' · '}<span class="text-warning">safe mode</span>{/if}{#if !ok.pipAvailable}{' · '}<span class="text-warning">pip unavailable: installs won’t work</span>{/if}
				</p>
			</div>
			<button class="btn btn-secondary btn-sm" disabled={busy || ok.restartCommand === false} title={restartHint} onclick={restart} data-testid="restart-octoprint"><Power />Restart OctoPrint</button>
		</div>

		{#if printing}
			<p class="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground" data-testid="plugins-printing">
				<TriangleAlert class="size-4 shrink-0 text-warning" />{printer.name} is printing: installs, updates and restarts wait until the print is over.
			</p>
		{/if}

		{#if ok.restartNeeded && !(running && (op?.kind === 'restart' || op?.kind === 'update'))}
			<div class="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-[0.8125rem]" data-testid="restart-banner" role="status">
				<RotateCcw class="size-4 shrink-0 text-warning" />
				<div class="min-w-0 flex-1">
					<p class="font-medium">Restart needed</p>
					<p class="text-xs text-muted-foreground">
						{ok.pending ? `${ok.pending} plugin change${ok.pending === 1 ? '' : 's'} take${ok.pending === 1 ? 's' : ''} effect` : 'The last change takes effect'} when OctoPrint restarts.{#if ok.restartCommand === false}{' '}OctoPrint has no restart command: restart it on its host.{/if}
					</p>
				</div>
				{#if ok.restartCommand !== false}
					<button class="btn btn-primary btn-sm" disabled={busy} title={busyHint || undefined} onclick={restart}><Power />Restart now</button>
				{/if}
			</div>
		{/if}

		{#if showOp && op}
			{@const ended = !!op.endedAt}
			<section class="card overflow-hidden" data-testid="plugin-op" data-phase={op.phase}>
				<div class="flex items-center gap-3 px-4 py-3 {ended ? '' : 'bg-primary-soft'}">
					{#if !ended}
						<LoaderCircle class="size-4 shrink-0 animate-spin text-primary" />
					{:else if op.phase === 'done'}
						<CircleCheck class="size-4 shrink-0 text-success" />
					{:else}
						<TriangleAlert class="size-4 shrink-0 text-danger" />
					{/if}
					<div class="min-w-0 flex-1">
						<p class="truncate text-[0.8125rem] font-medium">
							{#if !ended}{op.phase === 'restarting' ? 'Waiting for OctoPrint to come back' : `${OP_TITLE[op.kind]} ${op.label}`}…{:else}{op.message ?? `${OP_TITLE[op.kind]} ${op.label}`}{/if}
						</p>
						<p class="text-[0.6875rem] text-muted-foreground">Started {ago(op.startedAt)}{op.startedBy ? ` by ${op.startedBy}` : ''}{#if op.newVersion}{' · '}OctoPrint {op.newVersion}{/if}</p>
					</div>
					{#if ended}<button class="btn btn-ghost btn-icon btn-sm" aria-label="Hide this log" title="Hide" onclick={() => (dismissedOp = op?.id ?? null)} data-testid="plugin-op-hide"><X /></button>{/if}
				</div>
				{#if op.log.length}
					<div bind:this={logBox} class="max-h-56 overflow-y-auto border-t border-border bg-muted/30 px-4 py-2 font-mono text-[0.6875rem] leading-relaxed" data-testid="plugin-op-log">
						{#each op.log as l, i (i)}<p class="break-all whitespace-pre-wrap {STREAM[l.stream] ?? 'text-muted-foreground'}">{l.line}</p>{/each}
					</div>
				{/if}
			</section>
		{/if}

		<!-- OctoPrint's version -->
		<section class="card relative overflow-hidden p-4 sm:p-5" data-testid="octoprint-version">
			{#if octoUpdate}<div class="glow-top pointer-events-none absolute inset-x-0 -top-16 h-40 opacity-60"></div>{/if}
			<div class="relative flex flex-wrap items-center gap-x-6 gap-y-3">
				<div class="min-w-0 flex-1">
					<p class="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">OctoPrint</p>
					<div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<span class="font-mono text-2xl font-semibold tracking-tight tabular-nums" data-testid="octoprint-current">{octo?.current ?? ok.octoprint ?? live.snapshot.version ?? '—'}</span>
						{#if octoUpdate}
							<ArrowRight class="size-4 self-center text-muted-foreground" />
							<span class="font-mono text-2xl font-semibold tracking-tight text-primary tabular-nums" data-testid="octoprint-available">{octoUpdate.available}</span>
							<span class="badge badge-primary"><span class="size-1.5 rounded-full bg-current"></span>update available</span>
						{:else if check && !checkError}
							<span class="badge badge-success"><CircleCheck class="size-3" />up to date</span>
						{/if}
					</div>
					<p class="mt-1 text-xs text-muted-foreground">
						{#if checkError}<span class="text-danger">{checkError}</span>
						{:else if check}
							Checked {check.checkedAt ? ago(check.checkedAt) : 'just now'}{#if octo?.error}{' · '}<span class="text-warning">couldn’t reach the update server ({octo.error})</span>{/if}{#if pluginUpdates.length}{' · '}{pluginUpdates.length} plugin update{pluginUpdates.length === 1 ? '' : 's'}{/if}
						{:else}Checking for updates…{/if}
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					{#if octoUpdate?.releaseNotes}
						<a class="btn btn-ghost btn-sm" href={octoUpdate.releaseNotes} target="_blank" rel="noopener noreferrer">Release notes<ExternalLink /></a>
					{/if}
					<button class="btn btn-secondary btn-sm" disabled={checking} onclick={() => loadUpdates(true)} title="Ask OctoPrint to check for updates now" data-testid="check-updates"><RefreshCw class={checking ? 'animate-spin' : ''} />Check now</button>
					{#if octoUpdate && check}
						{@const why = updateBlocked(octoUpdate, check)}
						<button class="btn btn-primary btn-sm" disabled={busy || !!why} title={why ?? (busyHint || `Update OctoPrint to ${octoUpdate.available}`)} onclick={() => update(['octoprint'])} data-testid="update-octoprint"><Download />Update OctoPrint</button>
					{/if}
				</div>
			</div>
		</section>

		<Segmented
			label="Plugins and updates"
			items={[
				{ id: 'installed', label: 'Installed', icon: Puzzle, count: plugins.length },
				{ id: 'repository', label: 'Get more', icon: PackagePlus },
				{ id: 'updates', label: 'Updates', icon: Download, count: updates.length }
			]}
			active={pane}
			onselect={(id) => (pane = id as typeof pane)}
		/>

		{#if pane === 'installed'}
			<section class="card overflow-hidden" data-testid="plugins-installed">
				<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
					<label class="relative min-w-0 flex-1 basis-56">
						<Search class="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input class="input pl-8" type="search" placeholder="Search installed plugins" aria-label="Search installed plugins" bind:value={query} data-testid="plugins-search" />
					</label>
					<select class="input w-auto max-sm:flex-1" bind:value={filter} aria-label="Show" data-testid="plugins-filter">
						{#each FILTERS as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
					</select>
				</div>
				{#if !shown.length}
					<p class="px-4 py-8 text-center text-xs text-muted-foreground">{plugins.length ? 'No plugin matches.' : 'OctoPrint lists no plugins.'}</p>
				{:else}
					<ul class="divide-y divide-border">
						{#each shown as p (p.key)}
							{@const on = effectivelyEnabled(p)}
							{@const blockedToggle = toggleBlocked(p, ok.safeMode)}
							{@const blockedUninstall = uninstallBlocked(p)}
							<li class="flex items-start gap-3 px-4 py-3" data-plugin={p.key}>
								<div class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg {on ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground'}"><Puzzle class="size-4" /></div>
								<div class="min-w-0 flex-1">
									<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
										<span class="text-[0.8125rem] font-medium {on ? '' : 'text-muted-foreground'}">{p.name}</span>
										{#if p.version}<span class="font-mono text-[0.6875rem] text-muted-foreground">{p.version}</span>{/if}
										{#if p.bundled}<span class="badge">bundled</span>{/if}
										{#if !p.enabled && !p.pendingEnable && !p.safeModeVictim}<span class="badge">disabled</span>{/if}
										{#if p.safeModeVictim}<span class="badge badge-warning">safe mode</span>{/if}
										{#if p.incompatible}<span class="badge badge-danger">incompatible</span>{/if}
										{#if p.blacklisted}<span class="badge badge-danger">blocklisted</span>{/if}
										{@render pending(p)}
									</div>
									<p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
										{#if p.author}<span class="text-foreground/80">{p.author}</span>{#if p.description}{' · '}{/if}{/if}{p.description}
									</p>
									{#each p.notices as n, i (i)}
										<p class="mt-1 flex items-start gap-1.5 text-[0.6875rem] {n.important ? 'text-warning' : 'text-muted-foreground'}">
											<TriangleAlert class="mt-px size-3 shrink-0" /><span>{n.text}{#if n.link}{' '}<a class="underline" href={n.link} target="_blank" rel="noopener noreferrer">More</a>{/if}</span>
										</p>
									{/each}
									{#if p.url}<a class="mt-1 inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground" href={p.url} target="_blank" rel="noopener noreferrer">Homepage<ExternalLink class="size-3" /></a>{/if}
								</div>
								<div class="flex shrink-0 items-center gap-1">
									<span class="grid min-h-11 place-items-center px-1" title={blockedToggle ?? (busyHint || (p.disablingDiscouraged && on ? p.disablingDiscouraged : on ? 'Disable' : 'Enable'))}>
										<!-- Re-created when the answer comes back, so a refused toggle flips back. -->
										{#key `${on}:${!!toggling[p.key]}`}
											<Switch checked={toggling[p.key] ? !on : on} label="{on ? 'Disable' : 'Enable'} {p.name}" disabled={!!blockedToggle || busy || !!toggling[p.key]} onchange={() => toggle(p)} />
										{/key}
									</span>
									{#if !blockedUninstall}
										<button class="btn btn-ghost btn-icon min-h-11 min-w-11 hover:text-danger" disabled={busy} title={busyHint || `Uninstall ${p.name}`} aria-label="Uninstall {p.name}" onclick={() => uninstall(p)} data-testid="uninstall"><Trash2 /></button>
									{:else}
										<span class="min-w-11 max-sm:hidden"></span>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{:else if pane === 'repository'}
			<section class="card overflow-hidden" data-testid="plugins-repository">
				<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
					<label class="relative min-w-0 flex-1 basis-56">
						<Search class="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<!-- svelte-ignore a11y_autofocus -->
						<input class="input pl-8" type="search" placeholder="Search the plugin repository" aria-label="Search the plugin repository" bind:value={repoQuery} autofocus data-testid="repo-search" />
					</label>
					<button class="btn btn-ghost btn-icon btn-sm" title="Reload the repository" aria-label="Reload the repository" disabled={repoLoading} onclick={() => loadRepo(true)}><RefreshCw class={repoLoading ? 'animate-spin' : ''} /></button>
				</div>
				{#if repoError}
					<p class="px-4 py-8 text-center text-xs text-danger">{repoError}</p>
				{:else if !repo}
					<p class="flex items-center justify-center gap-2 px-4 py-8 text-xs text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />Loading the repository…</p>
				{:else if !repo.available}
					<p class="px-4 py-8 text-center text-xs text-muted-foreground">OctoPrint couldn’t load the plugin repository: it needs internet access (plugins.octoprint.org). Installing from a URL still works if OctoPrint can reach it.</p>
				{:else}
					{#if !repoQuery}<p class="px-4 pt-3 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Popular</p>{/if}
					{#if !results.length}
						<p class="px-4 py-8 text-center text-xs text-muted-foreground">Nothing in the repository matches “{repoQuery}”.</p>
					{:else}
						<ul class="divide-y divide-border">
							{#each results as r (r.id)}
								{@const have = installedKeys.has(r.id)}
								<li class="flex items-start gap-3 px-4 py-3" data-repo={r.id}>
									<div class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><PackagePlus class="size-4" /></div>
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
											{#if r.page}<a class="text-[0.8125rem] font-medium hover:underline" href={r.page} target="_blank" rel="noopener noreferrer">{r.title}</a>{:else}<span class="text-[0.8125rem] font-medium">{r.title}</span>{/if}
											{#if have}<span class="badge badge-success"><CircleCheck class="size-3" />installed</span>{/if}
											{#if !r.compatible}<span class="badge badge-danger" title="Not compatible with {r.incompatibleWith.join(', ')}">incompatible</span>{/if}
											{#if r.abandoned}<span class="badge badge-warning">abandoned</span>{/if}
										</div>
										<p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{#if r.author}<span class="text-foreground/80">{r.author}</span>{' · '}{/if}{r.description}</p>
										<p class="mt-1 flex flex-wrap gap-x-3 font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
											{#if r.installs != null}<span title="Instances last month">{fmtNum(r.installs)} installs</span>{/if}
											{#if r.stars != null}<span class="inline-flex items-center gap-1"><Star class="size-3" />{fmtNum(r.stars)}</span>{/if}
											{#if r.license}<span>{r.license}</span>{/if}
											{#if !r.compatible}<span class="text-danger">needs a different {r.incompatibleWith.join(' / ').replace(/this /g, '')}</span>{/if}
										</p>
									</div>
									{#if !have}
										<button class="btn btn-primary btn-sm shrink-0" disabled={busy || !r.compatible || !r.archive || !ok.pipAvailable} title={!r.compatible ? `Not compatible with ${r.incompatibleWith.join(', ')}` : busyHint || `Install ${r.title}`} onclick={() => install(r)} data-testid="install"><Download />Install</button>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
				<form class="border-t border-border bg-muted/30 px-4 py-4" onsubmit={installUrl} data-testid="install-url">
					<p class="text-[0.8125rem] font-medium">Install from a URL</p>
					<p class="mt-0.5 text-xs text-muted-foreground">A plugin archive (.zip) OctoPrint downloads itself. Plugins run with OctoPrint’s full rights on its host: only install ones you trust.</p>
					<div class="mt-2 flex flex-wrap gap-2">
						<input class="input min-w-0 flex-1 basis-64 font-mono" type="url" placeholder="https://github.com/…/archive/main.zip" aria-label="Plugin archive URL" bind:value={archiveUrl} data-testid="install-url-input" />
						<button class="btn btn-secondary max-sm:w-full" disabled={busy || !archiveUrl.trim()} title={busyHint || undefined}><Download />Install</button>
					</div>
				</form>
			</section>
		{:else}
			<section class="card overflow-hidden" data-testid="plugins-updates">
				<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
					<div class="min-w-0 flex-1">
						<h3 class="text-[0.8125rem] font-semibold tracking-tight">Software updates</h3>
						<p class="text-xs text-muted-foreground">{updates.length ? `${updates.length} update${updates.length === 1 ? '' : 's'} available` : check ? 'Everything is up to date' : 'Checking…'}</p>
					</div>
					{#if updates.length > 1}
						<button class="btn btn-primary btn-sm" disabled={busy} title={busyHint || 'Install every update, then restart OctoPrint'} onclick={() => update('all')} data-testid="update-all"><Download />Update all</button>
					{/if}
				</div>
				{#if check && (!check.environmentSupported || !check.storageSufficient)}
					<p class="border-b border-border bg-warning/5 px-4 py-2 text-xs text-warning">{!check.environmentSupported ? 'OctoPrint can’t update itself in this Python environment.' : 'Not enough free disk space on the OctoPrint host to update.'}</p>
				{/if}
				{#if check}
					<ul class="divide-y divide-border">
						<!-- OctoPrint first, then whatever has an update, then the rest. -->
						{#each [...(check.octoprint ? [check.octoprint] : []), ...check.targets.filter((x) => x.updateAvailable), ...check.targets.filter((x) => !x.updateAvailable)] as t (t.key)}
							{@const why = t.updateAvailable ? updateBlocked(t, check) : null}
							<li class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-target={t.key}>
								<div class="min-w-0 flex-1 basis-48">
									<p class="text-[0.8125rem] font-medium">{t.name}</p>
									<p class="flex flex-wrap items-center gap-1.5 font-mono text-xs tabular-nums">
										<span class="text-muted-foreground">{t.current ?? '?'}</span>
										{#if t.updateAvailable}<ArrowRight class="size-3 text-muted-foreground" /><span class="font-semibold text-primary">{t.available ?? '?'}</span>{/if}
										{#if t.error}<span class="font-sans text-[0.6875rem] text-warning">· check failed ({t.error})</span>{/if}
									</p>
								</div>
								{#if t.releaseNotes && t.updateAvailable}<a class="btn btn-ghost btn-sm" href={t.releaseNotes} target="_blank" rel="noopener noreferrer">Release notes<ExternalLink /></a>{/if}
								{#if t.updateAvailable}
									<button class="btn btn-secondary btn-sm" disabled={busy || !!why} title={why ?? (busyHint || `Update ${t.name}`)} onclick={() => update([t.key])} data-testid="update-target"><Download />Update</button>
								{:else if !t.error}
									<span class="badge badge-success"><CircleCheck class="size-3" />up to date</span>
								{/if}
							</li>
						{/each}
					</ul>
				{:else if checkError}
					<p class="px-4 py-8 text-center text-xs text-danger">{checkError}</p>
				{:else}
					<p class="flex items-center justify-center gap-2 px-4 py-8 text-xs text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />Checking…</p>
				{/if}
			</section>
		{/if}
	{/if}
</div>
