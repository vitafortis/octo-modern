<script lang="ts">
	import { untrack } from 'svelte';
	import { LoaderCircle, Search } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { listLayout } from '#lib/client/viewport.svelte.ts';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { printers, toast } from '#lib/client/state.svelte.ts';
	import type { AuditEvent, User } from '#lib/types.ts';

	let users = $state<User[]>([]);
	let filter = $state({ user: '', printer: '', action: '', q: '' });
	let events = $state<AuditEvent[]>([]);
	let loading = $state(false);
	let more = $state(true);
	const PAGE = 100;

	api.get<User[]>('/api/users').then((u) => (users = u)).catch(() => {});

	async function load(append = false) {
		loading = true;
		try {
			const p = new URLSearchParams({ limit: String(PAGE) });
			if (filter.user) p.set('user', filter.user);
			if (filter.printer) p.set('printer', filter.printer);
			if (filter.action) p.set('action', filter.action);
			if (filter.q.trim()) p.set('q', filter.q.trim());
			if (append && events.length) p.set('before', String(events.at(-1)!.id));
			const rows = await api.get<AuditEvent[]>(`/api/audit?${p}`);
			events = append ? [...events, ...rows] : rows;
			more = rows.length === PAGE;
		} catch (err) {
			toast('error', 'Could not load the audit log', errorMessage(err));
		} finally {
			loading = false;
		}
	}

	let timer: ReturnType<typeof setTimeout>;
	$effect(() => {
		void [filter.user, filter.printer, filter.action, filter.q];
		clearTimeout(timer);
		timer = setTimeout(() => untrack(() => load()), 200);
	});

	const ACTIONS: Record<string, string> = {
		'auth.login': 'Signed in',
		'auth.login_failed': 'Sign-in failed',
		'account.password': 'Changed own password',
		'printer.create': 'Added printer',
		'printer.update': 'Changed printer',
		'printer.delete': 'Removed printer',
		'printer.connect': 'Connected printer',
		'printer.disconnect': 'Disconnected printer',
		'printer.emergency_stop': 'Emergency stop',
		'printer.jog': 'Jogged',
		'printer.home': 'Homed',
		'printer.extrude': 'Extruded / retracted',
		'printer.tool': 'Selected tool',
		'printer.motors_off': 'Motors off',
		'printer.fan': 'Set fan',
		'printer.feedrate': 'Set feed rate',
		'printer.flowrate': 'Set flow rate',
		'printer.custom_control': 'Custom control',
		'job.start': 'Started print',
		'job.pause': 'Paused print',
		'job.resume': 'Resumed print',
		'job.cancel': 'Cancelled print',
		'job.restart': 'Restarted print',
		'temperature.set': 'Set temperature',
		'gcode.send': 'Sent G-code',
		'user.create': 'Added user',
		'user.update': 'Changed user',
		'user.delete': 'Deleted user',
		'user.access': 'Changed printer access',
		'settings.sso': 'Changed SSO',
		'token.create': 'Created API token',
		'token.revoke': 'Revoked API token',
		'backup.export': 'Exported backup',
		'backup.restore': 'Restored backup',
		'library.send': 'Sent from library',
		'library.save': 'Saved to library',
		'library.source.create': 'Added library source',
		'library.source.update': 'Changed library source',
		'library.source.delete': 'Removed library source',
		'settings.notifications': 'Changed notification settings',
		'notifications.channel.create': 'Added notification channel',
		'notifications.channel.update': 'Changed notification channel',
		'notifications.channel.delete': 'Removed notification channel',
		'notifications.test': 'Sent test notification',
		'notifications.log.clear': 'Cleared delivery log'
	};
	const GROUPS = [
		{ value: '', label: 'All actions' },
		{ value: 'job.', label: 'Print jobs' },
		{ value: 'temperature.', label: 'Temperatures' },
		{ value: 'gcode.', label: 'G-code' },
		{ value: 'printer.', label: 'Printers' },
		{ value: 'library.', label: 'Library' },
		{ value: 'user.', label: 'Users' },
		{ value: 'auth.', label: 'Sign-ins' }
	];
	const tone = (a: string) =>
		/failed|delete|cancel|emergency/.test(a) ? 'text-danger' : /gcode|disconnect|restore|revoke/.test(a) ? 'text-warning' : 'text-foreground';
</script>

<svelte:head><title>Audit · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Audit log" description="Every printer action and change, and who made it." />

	<div class="space-y-4 page-x pb-10">
		<div class="flex flex-wrap items-center gap-2">
			<select class="input h-9 w-44 text-xs max-sm:w-auto max-sm:min-w-0 max-sm:flex-1 max-sm:basis-[40%]" bind:value={filter.action}>
				{#each GROUPS as g (g.value)}<option value={g.value}>{g.label}</option>{/each}
			</select>
			<select class="input h-9 w-44 text-xs max-sm:w-auto max-sm:min-w-0 max-sm:flex-1 max-sm:basis-[40%]" bind:value={filter.user}>
				<option value="">Everyone</option>
				{#each users as u (u.id)}<option value={u.id}>{u.name ?? u.email}</option>{/each}
			</select>
			<select class="input h-9 w-44 text-xs max-sm:w-auto max-sm:min-w-0 max-sm:flex-1 max-sm:basis-[40%]" bind:value={filter.printer}>
				<option value="">All printers</option>
				{#each printers.list as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
			</select>
			<div class="relative max-sm:order-first max-sm:w-full">
				<Search class="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground touch:top-3.5 touch:size-4" />
				<input class="input h-9 w-56 pl-8 text-xs max-sm:w-full touch:pl-9" aria-label="Search the audit log" placeholder="Search…" bind:value={filter.q} />
			</div>
			{#if loading}<LoaderCircle class="size-4 animate-spin text-muted-foreground" />{/if}
		</div>

		<div class="card overflow-hidden">
			{#if listLayout.current}
				<ul class="divide-y divide-border text-[0.8125rem]" data-testid="audit-list">
					{#each events as e (e.id)}
						<li class="space-y-1 px-3 py-2.5">
							<div class="flex items-baseline gap-2">
								<span class="min-w-0 flex-1 font-medium {tone(e.action)}">{ACTIONS[e.action] ?? e.action}</span>
								<span class="shrink-0 text-xs text-muted-foreground" title={new Date(e.at).toLocaleString()}>{ago(e.at)}</span>
							</div>
							<p class="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
								<span class="min-w-0 [overflow-wrap:anywhere]">{e.userEmail ?? '—'}</span>
								{#if e.printerName}<span>· {#if printers.list.some((p) => p.id === e.printerId)}<a class="hover:text-primary" href="/p/{e.printerId}">{e.printerName}</a>{:else}{e.printerName}{/if}</span>{/if}
								{#if e.ip}<span class="font-mono">· {e.ip}</span>{/if}
							</p>
							{#if e.detail}<p class="font-mono text-[0.6875rem] [overflow-wrap:anywhere] text-muted-foreground">{e.detail}</p>{/if}
						</li>
					{:else}
						<li class="px-4 py-10 text-center text-xs text-muted-foreground">{loading ? 'Loading…' : 'Nothing recorded yet.'}</li>
					{/each}
				</ul>
			{:else}
			<table class="w-full table-fixed text-left text-[0.8125rem]">
				<thead class="border-b border-border bg-surface text-[0.6875rem] text-muted-foreground">
					<tr>
						<th class="w-32 px-4 py-2 font-medium">When</th>
						<th class="w-52 px-4 py-2 font-medium">Who</th>
						<th class="w-56 px-4 py-2 font-medium">What</th>
						<th class="px-4 py-2 font-medium">Details</th>
						<th class="w-32 px-4 py-2 font-medium">From</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each events as e (e.id)}
						<tr class="align-top hover:bg-accent/30">
							<td class="px-4 py-2.5 text-xs text-muted-foreground" title={new Date(e.at).toLocaleString()}>{ago(e.at)}</td>
							<td class="truncate px-4 py-2.5 text-xs">{e.userEmail ?? '—'}</td>
							<td class="px-4 py-2.5 text-xs">
								<span class={tone(e.action)}>{ACTIONS[e.action] ?? e.action}</span>
								{#if e.printerName}
									<p class="truncate text-[0.6875rem] text-muted-foreground">
										{#if printers.list.some((p) => p.id === e.printerId)}<a class="hover:text-primary" href="/p/{e.printerId}">{e.printerName}</a>{:else}{e.printerName}{/if}
									</p>
								{/if}
							</td>
							<td class="px-4 py-2.5 font-mono text-[0.6875rem] break-words text-muted-foreground">{e.detail ?? ''}</td>
							<td class="truncate px-4 py-2.5 font-mono text-[0.6875rem] text-muted-foreground">{e.ip ?? ''}</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="px-4 py-10 text-center text-xs text-muted-foreground">{loading ? 'Loading…' : 'Nothing recorded yet.'}</td></tr>
					{/each}
				</tbody>
			</table>
			{/if}
		</div>
		{#if more && events.length}
			<div class="text-center"><button class="btn btn-secondary btn-sm" disabled={loading} onclick={() => load(true)}>Load older</button></div>
		{/if}
	</div>
</div>
