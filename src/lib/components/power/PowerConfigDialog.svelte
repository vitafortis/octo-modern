<script lang="ts">
	import { CircleAlert, CircleCheck, LoaderCircle, PlugZap, Trash2 } from '@lucide/svelte';
	import Dialog from '../Dialog.svelte';
	import Switch from '../Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { refreshPower } from '#lib/client/power.svelte.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { DEFAULT_POWER_SETTINGS, formatEnergy, formatWatts, PLUG_KINDS, PLUG_LABEL, type PlugConfigView, type PlugKind, type PlugReading, type PowerSettings } from '#lib/power.ts';
	import type { Printer } from '#lib/types.ts';

	/** Admins: set up the printer's smart plug, test it, and choose the automations. */
	let { open = $bindable(false), printer }: { open: boolean; printer: Printer } = $props();

	type Config = Record<string, string | number>;
	const DEFAULTS: Record<PlugKind, Config> = {
		shelly: { url: '', channel: 0, generation: 'auto' },
		tasmota: { url: '', channel: 0 },
		homeassistant: { url: '', entityId: '', powerEntityId: '', energyEntityId: '' },
		http: { onUrl: '', onMethod: 'POST', onBody: '', offUrl: '', offMethod: 'POST', offBody: '', contentType: 'application/json', statusUrl: '', statusMethod: 'GET', onPattern: '', offPattern: '' }
	};
	const SECRETS: Record<PlugKind, { key: string; label: string; plain?: boolean; placeholder: string }[]> = {
		shelly: [
			{ key: 'username', label: 'Username', plain: true, placeholder: 'admin' },
			{ key: 'password', label: 'Password', placeholder: 'if the device has a login' }
		],
		tasmota: [
			{ key: 'username', label: 'Username', plain: true, placeholder: 'admin' },
			{ key: 'password', label: 'Web admin password', placeholder: 'if set' }
		],
		homeassistant: [{ key: 'token', label: 'Long-lived access token', placeholder: 'from your Home Assistant profile' }],
		http: [
			{ key: 'username', label: 'Username', plain: true, placeholder: 'optional (Basic/Digest)' },
			{ key: 'password', label: 'Password', placeholder: 'optional' },
			{ key: 'authorization', label: 'Authorization header', placeholder: 'optional, e.g. Bearer …' }
		]
	};
	const METHODS = ['GET', 'POST', 'PUT', 'PATCH'];

	let existing = $state<PlugConfigView | null>(null);
	let kind = $state<PlugKind>('shelly');
	let label = $state('');
	let config = $state<Config>({ ...DEFAULTS.shelly });
	let secrets = $state<Record<string, string>>({});
	let clear = $state<string[]>([]);
	let settings = $state<PowerSettings>(structuredClone(DEFAULT_POWER_SETTINGS));
	let loading = $state(false);
	let saving = $state(false);
	let testing = $state(false);
	let result = $state<{ ok: true; reading: PlugReading; ms: number } | { ok: false; message: string } | null>(null);

	const hints = $derived(existing && existing.kind === kind ? existing.secrets : {});

	$effect(() => {
		if (open) void load();
	});

	async function load() {
		loading = true;
		result = null;
		secrets = {};
		clear = [];
		try {
			const r = await api.get<{ plug: PlugConfigView | null }>(`/api/printers/${printer.id}/power/config`);
			existing = r.plug;
			if (r.plug) {
				kind = r.plug.kind;
				label = r.plug.label ?? '';
				config = { ...DEFAULTS[r.plug.kind], ...(r.plug.config as Config) };
				settings = structuredClone(r.plug.settings);
				if (r.plug.secrets.username) secrets.username = r.plug.secrets.username;
			} else {
				kind = 'shelly';
				label = '';
				config = { ...DEFAULTS.shelly };
				settings = structuredClone(DEFAULT_POWER_SETTINGS);
			}
		} catch (err) {
			toast('error', 'Could not load the plug settings', errorMessage(err));
		} finally {
			loading = false;
		}
	}

	function setKind(k: PlugKind) {
		if (k === kind) return;
		const url = config.url;
		kind = k;
		config = { ...DEFAULTS[k], ...(url && 'url' in DEFAULTS[k] && k !== 'homeassistant' ? { url } : {}) };
		secrets = existing?.kind === k && existing.secrets.username ? { username: existing.secrets.username } : {};
		clear = [];
		result = null;
	}

	const payload = () => ({ kind, label, config, secrets, clearSecrets: clear, settings });

	async function test() {
		testing = true;
		result = null;
		try {
			const r = await api.post<{ ok: true; reading: PlugReading; ms: number }>(`/api/printers/${printer.id}/power/test`, payload());
			result = r;
		} catch (err) {
			result = { ok: false, message: errorMessage(err) };
		} finally {
			testing = false;
		}
	}

	async function save() {
		saving = true;
		try {
			await api.put(`/api/printers/${printer.id}/power/config`, payload());
			toast('success', 'Smart plug saved');
			await refreshPower();
			open = false;
		} catch (err) {
			toast('error', 'Could not save the plug', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	async function remove() {
		const ok = await confirmAction({ title: `Remove ${printer.name}’s smart plug?`, body: 'octo·modern stops switching and reading it. The plug itself stays as it is.', confirmLabel: 'Remove', danger: true });
		if (!ok) return;
		try {
			await api.del(`/api/printers/${printer.id}/power/config`);
			toast('success', 'Smart plug removed');
			await refreshPower();
			open = false;
		} catch (err) {
			toast('error', 'Could not remove the plug', errorMessage(err));
		}
	}

	function forget(key: string) {
		clear = [...clear, key];
		secrets[key] = '';
	}
</script>

{#snippet field(key: string, labelText: string, placeholder: string, mono = true)}
	<label class="block"><span class="label">{labelText}</span><input class="input h-9 text-xs {mono ? 'font-mono' : ''}" {placeholder} bind:value={config[key]} name={key} autocomplete="off" /></label>
{/snippet}

<Dialog bind:open title="Smart plug · {printer.name}" description="Switch the printer’s power from octo·modern. Credentials stay on the server." width="max-w-2xl">
	{#if loading}
		<div class="grid h-40 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
	{:else}
		<div class="space-y-5 text-[0.8125rem]">
			<div>
				<span class="label">Device</span>
				<div class="grid grid-cols-2 gap-1.5 sm:grid-cols-4" role="radiogroup" aria-label="Device type">
					{#each PLUG_KINDS as k (k)}
						<button
							type="button"
							role="radio"
							aria-checked={kind === k}
							class="h-11 rounded-lg border px-3 text-xs font-medium transition-colors {kind === k ? 'border-primary/60 bg-primary-soft text-foreground' : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
							onclick={() => setKind(k)}>{PLUG_LABEL[k]}</button
						>
					{/each}
				</div>
			</div>

			<div class="grid gap-3 sm:grid-cols-2">
				{#if kind === 'shelly'}
					{@render field('url', 'Address', '192.168.1.50 or http://shelly-plug.lan')}
					<div class="grid grid-cols-2 gap-3">
						<label class="block"><span class="label">Channel</span><input class="input h-9 font-mono text-xs" type="number" min="0" max="7" bind:value={config.channel} name="channel" /></label>
						<label class="block"
							><span class="label">Generation</span>
							<select class="input h-9 text-xs" bind:value={config.generation} name="generation">
								<option value="auto">Detect</option><option value="1">Gen1</option><option value="2">Gen2+ (Plus/Pro)</option>
							</select></label
						>
					</div>
				{:else if kind === 'tasmota'}
					{@render field('url', 'Address', '192.168.1.51 or http://tasmota-plug.lan')}
					<label class="block"><span class="label">Relay (0 = the only one)</span><input class="input h-9 font-mono text-xs" type="number" min="0" max="8" bind:value={config.channel} name="channel" /></label>
				{:else if kind === 'homeassistant'}
					{@render field('url', 'Home Assistant URL', 'http://homeassistant.local:8123')}
					{@render field('entityId', 'Switch or light entity', 'switch.printer_plug')}
					{@render field('powerEntityId', 'Power sensor (W), optional', 'sensor.printer_plug_power')}
					{@render field('energyEntityId', 'Energy sensor (kWh), optional', 'sensor.printer_plug_energy')}
				{:else}
					<div class="grid grid-cols-[6rem_1fr] gap-2 sm:col-span-2">
						<label class="block"><span class="label">On</span><select class="input h-9 text-xs" bind:value={config.onMethod} aria-label="On method">{#each METHODS as m (m)}<option>{m}</option>{/each}</select></label>
						{@render field('onUrl', 'URL', 'http://relay.lan/relay/on')}
						<label class="block"><span class="label">Off</span><select class="input h-9 text-xs" bind:value={config.offMethod} aria-label="Off method">{#each METHODS as m (m)}<option>{m}</option>{/each}</select></label>
						{@render field('offUrl', 'URL', 'http://relay.lan/relay/off')}
						<label class="block"><span class="label">Status</span><select class="input h-9 text-xs" bind:value={config.statusMethod} aria-label="Status method">{#each METHODS as m (m)}<option>{m}</option>{/each}</select></label>
						{@render field('statusUrl', 'URL (optional)', 'http://relay.lan/relay/state')}
					</div>
					{@render field('onPattern', 'Status answer when on', '"relay":"ON"  or  /on/i')}
					{@render field('offPattern', 'Status answer when off (optional)', '"relay":"OFF"')}
					{@render field('onBody', 'On request body (optional)', '{"on": true}')}
					{@render field('offBody', 'Off request body (optional)', '{"on": false}')}
				{/if}
				<label class="block"><span class="label">Label (optional)</span><input class="input h-9 text-xs" placeholder="e.g. Desk plug" bind:value={label} name="label" /></label>
			</div>

			<div class="grid gap-3 sm:grid-cols-2">
				{#each SECRETS[kind] as f (f.key)}
					<label class="block">
						<span class="label flex items-center justify-between">{f.label}{#if !f.plain && hints[f.key] && !clear.includes(f.key)}<button type="button" class="text-[0.6875rem] font-normal text-muted-foreground hover:text-danger" onclick={() => forget(f.key)}>Clear saved</button>{/if}</span>
						<input
							class="input h-9 text-xs"
							type={f.plain ? 'text' : 'password'}
							autocomplete="off"
							name={f.key}
							placeholder={!f.plain && hints[f.key] && !clear.includes(f.key) ? 'saved — leave empty to keep' : f.placeholder}
							bind:value={secrets[f.key]}
						/>
					</label>
				{/each}
			</div>

			<div class="flex flex-wrap items-center gap-3">
				<button class="btn btn-secondary btn-sm" disabled={testing} onclick={test} data-testid="power-test">{#if testing}<LoaderCircle class="animate-spin" />{:else}<PlugZap />{/if}Test</button>
				{#if result?.ok}
					<p class="flex items-center gap-1.5 text-xs text-success" data-testid="power-test-result">
						<CircleCheck class="size-3.5" />Reached it in {result.ms} ms: {result.reading.on == null ? 'state unknown' : result.reading.on ? 'on' : 'off'}{#if result.reading.powerW != null}, {formatWatts(result.reading.powerW)}{/if}{#if result.reading.energyWh != null}, {formatEnergy(result.reading.energyWh)} total{/if}
					</p>
				{:else if result}
					<p class="flex items-start gap-1.5 text-xs text-danger" data-testid="power-test-result"><CircleAlert class="mt-px size-3.5 shrink-0" />{result.message}</p>
				{:else}
					<p class="text-xs text-muted-foreground">Reads the plug’s state; doesn’t switch it.</p>
				{/if}
			</div>

			<div class="space-y-3 rounded-xl border border-border p-3.5">
				<p class="text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">Automation</p>
				<div class="flex items-start justify-between gap-3">
					<div><p class="font-medium">Connect after power-on</p><p class="text-xs text-muted-foreground">Tell OctoPrint to connect once the printer is up, retrying for about 3 minutes.</p></div>
					<Switch label="Connect after power-on" bind:checked={settings.autoConnect} />
				</div>
				<div class="flex items-start justify-between gap-3">
					<div><p class="font-medium">Power on for new prints</p><p class="text-xs text-muted-foreground">When a file is sent to print (or queued) while the printer is off, switch it on and connect first.</p></div>
					<Switch label="Power on for new prints" bind:checked={settings.autoOn} />
				</div>
				<div class="flex items-start justify-between gap-3">
					<div><p class="font-medium">Power off after a print</p><p class="text-xs text-muted-foreground">Once the hotend has cooled and the printer has been idle, disconnect and switch off. A new print cancels it.</p></div>
					<Switch label="Power off after a print" bind:checked={settings.autoOff.enabled} />
				</div>
				{#if settings.autoOff.enabled}
					<div class="grid grid-cols-2 gap-3">
						<label class="block"><span class="label">Hotend below (°C)</span><input class="input h-9 font-mono text-xs" type="number" min="20" max="150" bind:value={settings.autoOff.hotendC} name="hotendC" /></label>
						<label class="block"><span class="label">Idle for (minutes)</span><input class="input h-9 font-mono text-xs" type="number" min="0" max="1440" bind:value={settings.autoOff.idleMinutes} name="idleMinutes" /></label>
					</div>
					<div class="flex items-start justify-between gap-3">
						<div><p class="font-medium">Stay on for the print queue</p><p class="text-xs text-muted-foreground">Don’t switch off while queued jobs wait for this printer’s bed to be cleared.</p></div>
						<Switch label="Stay on for the print queue" bind:checked={settings.autoOff.waitForQueue} />
					</div>
				{/if}
			</div>

			<div class="space-y-2 rounded-xl border border-border p-3.5">
				<p class="text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">Safety</p>
				<p class="text-xs text-muted-foreground">Turning off asks first while the printer is this hot, and twice while it prints.</p>
				<div class="grid grid-cols-2 gap-3">
					<label class="block"><span class="label">Hotend hot from (°C)</span><input class="input h-9 font-mono text-xs" type="number" min="20" max="300" bind:value={settings.hotHotendC} name="hotHotendC" /></label>
					<label class="block"><span class="label">Bed hot from (°C)</span><input class="input h-9 font-mono text-xs" type="number" min="20" max="150" bind:value={settings.hotBedC} name="hotBedC" /></label>
				</div>
			</div>
		</div>
	{/if}
	{#snippet footer()}
		{#if existing}<button class="btn btn-ghost btn-sm mr-auto hover:text-danger" onclick={remove}><Trash2 />Remove</button>{/if}
		<button class="btn btn-ghost btn-sm" onclick={() => (open = false)}>Cancel</button>
		<button class="btn btn-primary btn-sm" disabled={saving || loading} onclick={save} data-testid="power-save">{#if saving}<LoaderCircle class="animate-spin" />{/if}Save</button>
	{/snippet}
</Dialog>
