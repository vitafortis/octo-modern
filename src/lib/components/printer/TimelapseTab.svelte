<script lang="ts">
	import { onMount } from 'svelte';
	import { Clapperboard, Download, Film, LoaderCircle, Play, RefreshCw, Trash2, Wand2, X } from '@lucide/svelte';
	import { deleteTimelapse, deleteUnrendered, listTimelapses, renderTimelapse, saveTimelapseConfig, timelapseUrl } from '#lib/client/history.ts';
	import { errorMessage } from '#lib/client/api.ts';
	import { ago, bytes } from '#lib/client/format.ts';
	import { isAdmin } from '#lib/client/state.svelte.ts';
	import type { TimelapseConfig, TimelapseFile, TimelapseListing, TimelapseType } from '#lib/history.ts';
	import type { TabProps } from './tabs.ts';

	let { printer, live, canControl }: TabProps = $props();

	let listing = $state<TimelapseListing | null>(null);
	let error = $state('');
	let loading = $state(false);
	let playing = $state<TimelapseFile | null>(null);
	let draft = $state<TimelapseConfig | null>(null);
	let saving = $state(false);

	async function load() {
		loading = true;
		try {
			listing = await listTimelapses(printer.id);
			draft ??= { ...listing.config };
			if (playing && !listing.files.some((f) => f.name === playing!.name)) playing = null;
			error = '';
		} catch (err) {
			error = errorMessage(err);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
		let t: ReturnType<typeof setTimeout> | undefined;
		const soon = () => {
			clearTimeout(t);
			t = setTimeout(load, 800);
		};
		// OctoPrint's timelapse events: capture, rendering, done, failed; and a print ending (frames become "unrendered").
		const offs = ['CaptureDone', 'MovieRendering', 'MovieDone', 'MovieFailed', 'PrintStarted', 'PrintDone', 'PrintFailed', 'push:timelapse'].map((e) => live.on(e, soon));
		// While something renders, check now and then.
		const every = setInterval(() => listing?.unrendered.some((u) => u.rendering || u.processing) && void load(), 5000);
		return () => {
			offs.forEach((off) => off());
			clearTimeout(t);
			clearInterval(every);
		};
	});

	const TYPES: { value: TimelapseType; label: string; hint: string }[] = [
		{ value: 'off', label: 'Off', hint: 'No timelapse is recorded.' },
		{ value: 'zchange', label: 'Each layer', hint: 'A frame each time Z changes (each layer).' },
		{ value: 'timed', label: 'Timed', hint: 'A frame every few seconds.' }
	];
	const typeLabel = (t: TimelapseType) => (t === 'zchange' ? 'On layer change' : (TYPES.find((x) => x.value === t)?.label ?? t));
	const dirty = $derived(!!listing && !!draft && JSON.stringify(draft) !== JSON.stringify(listing.config));

	async function save() {
		if (!draft) return;
		saving = true;
		const next = await saveTimelapseConfig(printer.id, $state.snapshot(draft));
		saving = false;
		if (next) {
			listing = next;
			draft = { ...next.config };
		}
	}

	async function remove(f: TimelapseFile) {
		if (await deleteTimelapse(printer.id, f)) {
			if (playing?.name === f.name) playing = null;
			void load();
		}
	}

	const date = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
	const summary = (c: TimelapseConfig) =>
		c.type === 'off'
			? 'Off'
			: [typeLabel(c.type), c.type === 'timed' && c.interval ? `every ${c.interval} s` : null, c.fps ? `${c.fps} fps` : null, c.postRoll ? `${c.postRoll} s post-roll` : null].filter(Boolean).join(' · ');
</script>

<div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
	<div class="min-w-0 space-y-4">
		{#if playing}
			<div class="card overflow-hidden">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video src={timelapseUrl(printer.id, playing.name)} controls autoplay preload="metadata" class="aspect-video w-full bg-black" data-testid="timelapse-player"></video>
				<div class="flex items-center gap-3 px-4 py-2.5">
					<Film class="size-4 text-muted-foreground" />
					<span class="min-w-0 flex-1 truncate text-[13px] font-medium">{playing.name}</span>
					<a class="btn btn-ghost btn-sm" href={timelapseUrl(printer.id, playing.name, true)} download={playing.name}><Download />Download</a>
					<button class="btn btn-ghost btn-icon btn-sm" title="Close player" aria-label="Close player" onclick={() => (playing = null)}><X /></button>
				</div>
			</div>
		{/if}

		<div class="flex items-center gap-2">
			<h2 class="text-[13px] font-medium">Timelapses</h2>
			{#if listing}<span class="badge">{listing.files.length}</span>{/if}
			<button class="btn btn-ghost btn-icon btn-sm ml-auto" title="Refresh" aria-label="Refresh" onclick={load} disabled={loading}><RefreshCw class={loading ? 'animate-spin' : ''} /></button>
		</div>

		{#if error}
			<div class="card px-4 py-6 text-center text-xs text-danger">{error}</div>
		{:else if !listing}
			<div class="card grid h-40 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
		{:else if !listing.files.length}
			<div class="card relative overflow-hidden px-6 py-12 text-center">
				<div class="dot-grid mask-fade pointer-events-none absolute inset-0"></div>
				<div class="relative mx-auto max-w-md">
					<div class="mx-auto grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><Clapperboard class="size-5" /></div>
					<h3 class="mt-4 text-[15px] font-semibold tracking-tight">No timelapses yet</h3>
					<p class="mt-1.5 text-[13px] text-muted-foreground">
						{listing.config.type === 'off'
							? 'Timelapses are off. Turn them on in the settings and the next print is recorded.'
							: 'The next print is recorded; OctoPrint renders the video when it ends.'}
					</p>
				</div>
			</div>
		{:else}
			<div class="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
				{#each listing.files as f (f.name)}
					<div class="card group overflow-hidden {playing?.name === f.name ? 'ring-2 ring-primary/60' : ''}" data-timelapse={f.name}>
						<button
							class="relative block aspect-video w-full overflow-hidden bg-muted"
							disabled={!f.playable}
							title={f.playable ? 'Play' : 'Your browser can’t play this format; download it instead'}
							aria-label="Play {f.name}"
							onclick={() => (playing = f)}
						>
							{#if f.thumbnail}
								<img src={timelapseUrl(printer.id, f.thumbnail)} alt="" loading="lazy" class="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
							{:else}
								<span class="grid size-full place-items-center text-muted-foreground/60"><Film class="size-6" /></span>
							{/if}
							{#if f.playable}
								<span class="absolute inset-0 grid place-items-center bg-black/0 transition-colors group-hover:bg-black/30">
									<span class="grid size-10 place-items-center rounded-full bg-black/55 text-white opacity-80 backdrop-blur-sm transition-opacity group-hover:opacity-100"><Play class="ml-0.5 size-4 fill-current" /></span>
								</span>
							{/if}
							{#if /-fail\.[a-z0-9]+$/i.test(f.name)}<span class="badge badge-danger absolute top-2 left-2 bg-card/90">failed print</span>{/if}
						</button>
						<div class="flex items-center gap-2 px-3 py-2">
							<div class="min-w-0 flex-1">
								<p class="truncate text-[12px] font-medium" title={f.name}>{f.name}</p>
								<p class="text-[11px] text-muted-foreground" title={f.date ? new Date(f.date).toLocaleString() : undefined}>{date(f.date)} · {bytes(f.bytes)}</p>
							</div>
							<a class="btn btn-ghost btn-icon btn-sm" href={timelapseUrl(printer.id, f.name, true)} download={f.name} title="Download" aria-label="Download {f.name}"><Download /></a>
							{#if canControl}
								<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Delete" aria-label="Delete {f.name}" onclick={() => remove(f)}><Trash2 /></button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}

		{#if listing?.unrendered.length}
			<div class="card overflow-hidden">
				<p class="border-b border-border bg-surface px-4 py-2 text-[11px] font-medium text-muted-foreground">Not rendered yet</p>
				<div class="divide-y divide-border">
					{#each listing.unrendered as u (u.name)}
						<div class="flex items-center gap-3 px-4 py-2.5 text-[13px]" data-unrendered={u.name}>
							<Clapperboard class="size-4 shrink-0 text-muted-foreground" />
							<div class="min-w-0 flex-1">
								<p class="truncate font-medium">{u.name}</p>
								<p class="text-[11px] text-muted-foreground">{u.count ?? '?'} frames · {bytes(u.bytes)}{u.date ? ` · ${ago(new Date(u.date).toISOString())}` : ''}</p>
							</div>
							{#if u.recording}
								<span class="badge badge-primary"><span class="size-1.5 animate-pulse rounded-full bg-current"></span>recording</span>
							{:else if u.rendering || u.processing}
								<span class="badge badge-warning"><LoaderCircle class="animate-spin" />rendering</span>
							{:else if canControl}
								<button class="btn btn-secondary btn-sm" onclick={async () => (await renderTimelapse(printer.id, u)) && load()}><Wand2 />Render</button>
								<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Delete frames" aria-label="Delete frames of {u.name}" onclick={async () => (await deleteUnrendered(printer.id, u)) && load()}><Trash2 /></button>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	<aside class="space-y-3">
		<div class="card">
			<div class="border-b border-border px-4 py-3">
				<p class="text-[13px] font-medium">Timelapse settings</p>
				<p class="mt-0.5 text-[11px] text-muted-foreground">{listing ? summary(listing.config) : 'Loading…'}</p>
			</div>
			{#if listing && draft}
				<div class="space-y-3.5 px-4 py-3.5">
					{#if !listing.enabled}
						<p class="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs">OctoPrint can’t record timelapses yet: it needs a webcam snapshot URL and ffmpeg (OctoPrint → Settings → Webcam & Timelapse).</p>
					{/if}
					<fieldset disabled={!isAdmin()} class="space-y-3.5">
						<div>
							<span class="label">Record</span>
							<div class="grid grid-cols-3 rounded-lg border border-border bg-surface p-0.5" role="radiogroup" aria-label="Timelapse mode">
								{#each TYPES as t (t.value)}
									<button
										type="button"
										role="radio"
										aria-checked={draft.type === t.value}
										title={t.hint}
										class="h-7 rounded-md px-1 text-[11px] font-medium transition-colors {draft.type === t.value ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
										onclick={() => (draft!.type = t.value)}>{t.label}</button
									>
								{/each}
							</div>
							<p class="mt-1.5 text-[11px] text-muted-foreground">{TYPES.find((t) => t.value === draft!.type)?.hint}</p>
						</div>
						{#if draft.type !== 'off'}
							<div class="grid grid-cols-2 gap-3">
								{#if draft.type === 'timed'}
									<label><span class="label">Interval (s)</span><input class="input h-8 text-xs" type="number" min="1" max="3600" bind:value={draft.interval} /></label>
								{:else}
									<label><span class="label">Min. delay (s)</span><input class="input h-8 text-xs" type="number" min="0" max="600" step="0.5" bind:value={draft.minDelay} /></label>
								{/if}
								<label><span class="label">Frame rate (fps)</span><input class="input h-8 text-xs" type="number" min="1" max="120" bind:value={draft.fps} /></label>
								<label><span class="label">Post-roll (s)</span><input class="input h-8 text-xs" type="number" min="0" max="600" bind:value={draft.postRoll} /></label>
								{#if draft.type === 'zchange'}
									<label><span class="label">Z-hop (mm)</span><input class="input h-8 text-xs" type="number" min="0" max="10" step="0.1" bind:value={draft.retractionZHop} /></label>
								{/if}
							</div>
						{/if}
					</fieldset>
					{#if isAdmin()}
						<div class="flex justify-end gap-2">
							{#if dirty}<button class="btn btn-ghost btn-sm" onclick={() => (draft = { ...listing!.config })}>Reset</button>{/if}
							<button class="btn btn-primary btn-sm" disabled={!dirty || saving} onclick={save}>{#if saving}<LoaderCircle class="animate-spin" />{/if}Save</button>
						</div>
					{:else}
						<p class="text-[11px] text-muted-foreground">Only admins can change these.</p>
					{/if}
				</div>
			{/if}
		</div>
		<p class="px-1 text-[11px] leading-relaxed text-muted-foreground">
			OctoPrint captures the frames and renders the video with ffmpeg after each print. Videos play and download through octo·modern, so the browser never needs to reach OctoPrint.
		</p>
	</aside>
</div>
