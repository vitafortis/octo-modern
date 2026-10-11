<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ArrowDownToLine, CaseUpper, Check, Copy, Eraser, Filter, Lock, OctagonX, Search, SendHorizontal, TriangleAlert, X } from '@lucide/svelte';
	import { emergencyStop, sendGcode } from '#lib/client/actions.ts';
	import { session, toast } from '#lib/client/state.svelte.ts';
	import { DEFAULT_HIDDEN, FILTERS, highlight, lineKind, makeLineFilter, matchesSearch, type FilterId, type LineKind } from '#lib/terminal/filters.ts';
	import { completeGcode, gcodeInfo, uppercaseLine, type GcodeInfo } from '#lib/terminal/gcodes.ts';
	import { isConnected } from '#lib/printer.ts';
	import type { TabProps } from './tabs.ts';
	import ActionMenu from '../ActionMenu.svelte';
	import { phone } from '#lib/client/viewport.svelte.ts';

	let { printer, live, canControl }: TabProps = $props();

	// Phones: the filters fold into a popover and Copy / Clear / Emergency stop into a menu.
	let filtersOpen = $state(false);
	let filtersBox = $state<HTMLElement>();
	function onwindowclick(e: MouseEvent) {
		if (filtersOpen && filtersBox && !filtersBox.contains(e.target as Node)) filtersOpen = false;
	}

	const ROW = 20;
	const OVERSCAN = 12;
	const HISTORY_MAX = 100;

	// --- preferences and history, per user (and per printer for the history) -------------
	const who = $derived(session.viewer?.email ?? 'anonymous');
	const prefsKey = $derived(`ocm-term-prefs:${who}`);
	const historyKey = $derived(`ocm-term-history:${who}:${printer.id}`);

	let hidden = $state<FilterId[]>([...DEFAULT_HIDDEN]);
	let uppercase = $state(true);
	let history = $state<string[]>([]);

	function readJson<T>(key: string, fallback: T): T {
		try {
			const raw = localStorage.getItem(key);
			return raw ? (JSON.parse(raw) as T) : fallback;
		} catch {
			return fallback;
		}
	}
	function writeJson(key: string, value: unknown) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {}
	}

	onMount(() => {
		const p = readJson<{ hidden?: FilterId[]; uppercase?: boolean }>(prefsKey, {});
		if (Array.isArray(p.hidden)) hidden = p.hidden.filter((id) => FILTERS.some((f) => f.id === id));
		if (typeof p.uppercase === 'boolean') uppercase = p.uppercase;
		const h = readJson<unknown>(historyKey, []);
		if (Array.isArray(h)) history = h.filter((x): x is string => typeof x === 'string').slice(-HISTORY_MAX);
	});
	const savePrefs = () => writeJson(prefsKey, { hidden, uppercase });

	function toggleFilter(id: FilterId) {
		hidden = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
		savePrefs();
	}

	// --- the log ---------------------------------------------------------------------------
	let query = $state('');
	/** Lines with an id below this were cleared from the view. */
	let clearedBefore = $state(0);
	let viewport = $state<HTMLDivElement>();
	let scrollTop = $state(0);
	let height = $state(400);
	let follow = $state(true);
	let anchor = { id: 0, offset: 0 };
	let seenId = $state(0);

	const lineFilter = $derived(makeLineFilter(hidden));
	const rows = $derived.by(() => {
		const out: { id: number; text: string; kind: LineKind }[] = [];
		const base = live.logBase;
		live.logs.forEach((text, i) => {
			const id = base + i;
			if (id < clearedBefore || !lineFilter(text) || !matchesSearch(text, query)) return;
			out.push({ id, text, kind: lineKind(text) });
		});
		return out;
	});
	const total = $derived(live.logs.length - Math.max(0, Math.min(live.logs.length, clearedBefore - live.logBase)));
	const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
	const last = $derived(Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN));
	const visible = $derived(rows.slice(first, last));
	const unseen = $derived(follow ? 0 : rows.filter((r) => r.id > seenId).length);

	function onscroll() {
		if (!viewport) return;
		scrollTop = viewport.scrollTop;
		const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < ROW * 1.5;
		follow = atBottom;
		const i = Math.floor(viewport.scrollTop / ROW);
		anchor = { id: rows[i]?.id ?? 0, offset: viewport.scrollTop - i * ROW };
		if (atBottom) seenId = rows.at(-1)?.id ?? seenId;
	}

	async function toBottom() {
		follow = true;
		await tick();
		if (viewport) viewport.scrollTop = viewport.scrollHeight;
		seenId = rows.at(-1)?.id ?? seenId;
	}

	// New lines: stick to the bottom while following; otherwise keep the line being read in place.
	$effect(() => {
		void rows;
		if (follow) {
			void tick().then(() => {
				if (!viewport || !follow) return;
				viewport.scrollTop = viewport.scrollHeight;
				seenId = rows.at(-1)?.id ?? seenId;
			});
		} else if (viewport) {
			const i = rows.findIndex((r) => r.id >= anchor.id);
			if (i >= 0) {
				const top = i * ROW + anchor.offset;
				if (Math.abs(viewport.scrollTop - top) >= 1) viewport.scrollTop = top;
			}
		}
	});

	function clearView() {
		clearedBefore = live.logBase + live.logs.length;
		void toBottom();
	}

	let copied = $state(false);
	async function copy() {
		const text = rows.map((r) => r.text).join('\n');
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Plain-http deployments have no async clipboard; fall back to a selection copy.
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand('copy');
			ta.remove();
			if (!ok) return toast('error', 'Couldn’t copy', 'The browser blocked clipboard access.');
		}
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	const KIND_CLASS: Record<LineKind, string> = {
		send: 'text-[var(--syntax-keyword)]',
		recv: 'text-foreground',
		error: 'text-danger',
		warn: 'text-warning',
		info: 'text-muted-foreground'
	};
	const split = (text: string) => {
		const m = /^(Send|Recv):\s?/.exec(text);
		return m ? { prefix: m[1], body: text.slice(m[0].length) } : { prefix: '', body: text };
	};

	// --- the prompt --------------------------------------------------------------------------
	let input = $state('');
	let textarea = $state<HTMLTextAreaElement>();
	let caret = $state(0);
	let focused = $state(false);
	let sending = $state(false);
	let histIndex = -1;
	let draft = '';
	let sel = $state(-1);
	let dismissedFor = $state<string | null>(null);

	const connected = $derived(isConnected(live.snapshot.state));
	const lineStart = $derived(input.lastIndexOf('\n', caret - 1) + 1);
	const currentLine = $derived(input.slice(lineStart, (input.indexOf('\n', caret) + 1 || input.length + 1) - 1));
	const token = $derived.by(() => {
		const before = input.slice(lineStart, caret);
		return /^\s*[GMgm]\d*$/.test(before) ? before.trim() : '';
	});
	const suggestions = $derived(token ? completeGcode(token) : []);
	const showSuggestions = $derived(focused && suggestions.length > 0 && dismissedFor !== token && !(suggestions.length === 1 && suggestions[0].code === token.toUpperCase()));
	const currentInfo = $derived(gcodeInfo(currentLine));
	const lineCount = $derived(input.split('\n').filter((l) => l.trim() && !l.trim().startsWith(';')).length);

	function updateCaret() {
		caret = textarea?.selectionStart ?? input.length;
	}

	function accept(g: GcodeInfo) {
		const before = input.slice(0, lineStart);
		const after = input.slice(caret);
		const insert = g.code + (after.startsWith(' ') ? '' : ' ');
		input = before + insert + after;
		sel = -1;
		void tick().then(() => {
			const pos = before.length + insert.length;
			textarea?.setSelectionRange(pos, pos);
			textarea?.focus();
			updateCaret();
		});
	}

	function setInput(v: string) {
		input = v;
		void tick().then(() => {
			textarea?.setSelectionRange(v.length, v.length);
			updateCaret();
		});
	}

	function onkeydown(e: KeyboardEvent) {
		const ta = e.currentTarget as HTMLTextAreaElement;
		if (showSuggestions) {
			if (e.key === 'ArrowDown') return (e.preventDefault(), (sel = (sel + 1) % suggestions.length));
			if (e.key === 'ArrowUp') return (e.preventDefault(), (sel = sel <= 0 ? suggestions.length - 1 : sel - 1));
			if (e.key === 'Tab' || (e.key === 'Enter' && sel >= 0 && !e.shiftKey)) return (e.preventDefault(), accept(suggestions[Math.max(0, sel)]));
			if (e.key === 'Escape') return (e.preventDefault(), (dismissedFor = token));
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void send();
			return;
		}
		const onFirstLine = !ta.value.slice(0, ta.selectionStart).includes('\n');
		const onLastLine = !ta.value.slice(ta.selectionEnd).includes('\n');
		if (e.key === 'ArrowUp' && onFirstLine && history.length) {
			e.preventDefault();
			if (histIndex === -1) draft = input;
			histIndex = Math.min(history.length - 1, histIndex + 1);
			setInput(history[history.length - 1 - histIndex]);
		} else if (e.key === 'ArrowDown' && onLastLine && histIndex >= 0) {
			e.preventDefault();
			histIndex--;
			setInput(histIndex === -1 ? draft : history[history.length - 1 - histIndex]);
		}
	}

	async function send() {
		const lines = input
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith(';'))
			.map((l) => (uppercase ? uppercaseLine(l) : l));
		if (!lines.length || sending) return;
		sending = true;
		const ok = await sendGcode(live.id, lines);
		sending = false;
		if (!ok) return;
		const entry = lines.join('\n');
		history = [...history.filter((h) => h !== entry), entry].slice(-HISTORY_MAX);
		writeJson(historyKey, history);
		histIndex = -1;
		draft = '';
		input = '';
		void toBottom();
		textarea?.focus();
	}
</script>

<svelte:window onclick={onwindowclick} />

{#snippet filterChips()}
	{#each FILTERS as f (f.id)}
		{@const on = hidden.includes(f.id)}
		<button
			class="h-6 rounded-md border px-2 text-[11px] transition-colors touch:h-10 touch:px-3 touch:text-[13px] {on ? 'border-primary/40 bg-primary-soft text-primary' : 'border-border text-muted-foreground hover:text-foreground'}"
			aria-pressed={on}
			title="{on ? 'Hidden' : 'Shown'}: {f.hint}"
			data-filter={f.id}
			onclick={() => toggleFilter(f.id)}>{f.label}</button
		>
	{/each}
{/snippet}

<!-- Fills the space under the tabs; on phones down to the keyboard when it's up. -->
<div class="card flex min-h-[16rem] flex-1 flex-col overflow-hidden short:min-h-[11rem] lg:min-h-[28rem]" data-testid="terminal-tab">
	<!-- Toolbar -->
	<div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 max-sm:px-2">
		<div class="relative max-sm:min-w-0 max-sm:flex-1">
			<Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
			<input class="input h-7 w-52 pr-7 pl-8 text-xs max-sm:w-full" placeholder="Search the log" aria-label="Search the log" bind:value={query} />
			{#if query}
				<button class="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground touch:p-2" aria-label="Clear search" onclick={() => (query = '')}><X class="size-3.5" /></button>
			{/if}
		</div>
		{#if phone.current}
			<div class="relative" bind:this={filtersBox}>
				<button class="btn btn-secondary btn-sm {hidden.length ? 'text-primary' : ''}" aria-expanded={filtersOpen} aria-label="Line filters" onclick={() => (filtersOpen = !filtersOpen)}><Filter />{hidden.length || ''}</button>
				{#if filtersOpen}
					<div class="card absolute top-full right-0 z-30 mt-1.5 w-[min(18rem,calc(100vw-2rem))] p-3 shadow-surface-lg" role="dialog" aria-label="Line filters">
						<p class="mb-2 text-xs font-medium">Hide these lines</p>
						<div class="flex flex-wrap gap-1.5" role="group" aria-label="Hide lines">{@render filterChips()}</div>
						<p class="mt-2.5 font-mono text-[11px] text-muted-foreground tabular-nums">{rows.length}{rows.length !== total ? ` / ${total}` : ''} lines shown</p>
					</div>
				{/if}
			</div>
			<ActionMenu
				title="Terminal"
				actions={[
					{ label: copied ? 'Copied' : 'Copy the lines shown', icon: Copy, disabled: !rows.length, onclick: copy },
					{ label: 'Clear the view', icon: Eraser, hint: 'OctoPrint keeps its log', disabled: !rows.length, onclick: clearView },
					{ label: 'Emergency stop', icon: OctagonX, danger: true, hidden: !canControl, disabled: !connected, hint: 'M112 — asks first', onclick: () => emergencyStop(printer.id, printer.name) }
				]}
			/>
		{:else}
		<div class="flex flex-wrap items-center gap-1" role="group" aria-label="Hide lines">
			<span class="mr-0.5 flex items-center gap-1 text-[11px] text-muted-foreground"><Filter class="size-3" />Hide</span>
			{@render filterChips()}
		</div>
		<div class="ml-auto flex items-center gap-1">
			<span class="mr-1 font-mono text-[11px] text-muted-foreground tabular-nums" data-testid="line-count">{rows.length}{rows.length !== total ? ` / ${total}` : ''} lines</span>
			<button class="btn btn-ghost btn-sm" onclick={copy} disabled={!rows.length} title="Copy the lines shown">{#if copied}<Check />Copied{:else}<Copy />Copy{/if}</button>
			<button class="btn btn-ghost btn-sm" onclick={clearView} disabled={!rows.length} title="Clear the view (OctoPrint keeps its log)"><Eraser />Clear</button>
			{#if canControl}
				<button class="btn btn-danger btn-sm ml-1" disabled={!connected} title="Emergency stop (M112)" onclick={() => emergencyStop(printer.id, printer.name)}><OctagonX />Emergency stop</button>
			{/if}
		</div>
		{/if}
	</div>

	<!-- Log (virtualized: only the rows in view are rendered) -->
	<div class="relative min-h-0 flex-1">
		<div class="absolute inset-0 overflow-auto bg-surface/60 font-mono text-[12px] leading-5" bind:this={viewport} bind:clientHeight={height} {onscroll} data-testid="terminal-log" role="log" aria-live="off">
			<div class="w-max min-w-full px-3" style="height:{rows.length * ROW}px; padding-top:{first * ROW}px">
				{#each visible as r (r.id)}
					{@const parts = split(r.text)}
					<div class="flex h-5 items-center whitespace-pre {KIND_CLASS[r.kind]}" data-line>
						{#if parts.prefix}<span class="mr-2 w-9 shrink-0 text-[10px] tracking-wide text-muted-foreground/70 uppercase select-none">{parts.prefix}</span>{:else}<span class="mr-2 w-9 shrink-0"></span>{/if}
						<span>{#each highlight(parts.body, query) as p, pi (pi)}{#if p.hit}<mark class="rounded-sm bg-warning/30 text-foreground">{p.text}</mark>{:else}{p.text}{/if}{/each}</span>
					</div>
				{/each}
			</div>
			{#if !rows.length}
				<div class="absolute inset-0 grid place-items-center font-sans text-xs text-muted-foreground">
					{#if query}No lines match “{query}”.{:else if live.logs.length && total === 0}View cleared. New lines appear here.{:else if live.logs.length}Every line is hidden by the filters.{:else if connected}Waiting for printer output…{:else}Connect the printer to see its serial log.{/if}
				</div>
			{/if}
		</div>
		{#if !follow && rows.length}
			<button class="btn btn-secondary btn-sm absolute right-4 bottom-3 shadow-surface-lg" onclick={toBottom} data-testid="resume-follow">
				<ArrowDownToLine />{unseen ? `${unseen} new line${unseen === 1 ? '' : 's'}` : 'Paused'} · follow
			</button>
		{/if}
	</div>

	<!-- Prompt -->
	{#if canControl}
		<form
			class="relative border-t border-border px-3 py-2.5 max-sm:px-2 max-sm:py-2"
			onsubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			{#if showSuggestions}
				<ul class="card absolute bottom-full left-3 z-20 mb-1 w-96 max-w-[calc(100%-1.5rem)] overflow-hidden p-1 shadow-surface-lg" role="listbox" aria-label="G-code suggestions" data-testid="gcode-suggestions">
					{#each suggestions as g, i (g.code)}
						<li role="option" aria-selected={i === sel}>
							<button
								type="button"
								class="flex w-full items-center gap-3 rounded-md px-2 py-1 text-left text-xs touch:py-2.5 touch:text-[13px] {i === sel ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60'}"
								onmousedown={(e) => e.preventDefault()}
								onclick={() => accept(g)}
							>
								<span class="w-12 font-mono font-semibold text-foreground">{g.code}</span>
								<span class="truncate">{g.description}</span>
								{#if g.danger}<TriangleAlert class="ml-auto size-3.5 shrink-0 text-warning" />{/if}
							</button>
						</li>
					{/each}
					<li class="kbd-hint px-2 pt-1 pb-0.5 text-[10px] text-muted-foreground/80"><kbd class="kbd">Tab</kbd> complete · <kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> choose · <kbd class="kbd">Esc</kbd> close</li>
				</ul>
			{/if}
			<div class="flex items-end gap-2">
				<span class="pb-2 font-mono text-xs text-primary select-none max-sm:hidden">&gt;</span>
				<textarea
					bind:this={textarea}
					bind:value={input}
					class="input max-h-40 min-h-9 flex-1 resize-none py-2 font-mono text-xs leading-5"
					rows={Math.min(6, Math.max(1, input.split('\n').length))}
					placeholder={connected ? (phone.current ? 'G-code, e.g. M105' : 'G-code, e.g. M105 · Shift+Enter for another line') : 'Connect the printer to send G-code'}
					aria-label="G-code to send"
					spellcheck="false"
					autocomplete="off"
					disabled={!connected}
					data-testid="terminal-input"
					{onkeydown}
					oninput={() => {
						updateCaret();
						sel = -1;
						histIndex = -1;
					}}
					onkeyup={updateCaret}
					onclick={updateCaret}
					onfocus={() => (focused = true)}
					onblur={() => (focused = false)}
				></textarea>
				<button class="btn btn-primary btn-sm h-9" disabled={!connected || !lineCount || sending} aria-label="Send"><SendHorizontal /><span class="max-sm:hidden">Send{lineCount > 1 ? ` ${lineCount}` : ''}</span></button>
			</div>
			<div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-[11px] text-muted-foreground max-sm:pl-0">
				<button
					type="button"
					class="flex items-center gap-1 rounded px-1 transition-colors {uppercase ? 'text-primary' : 'hover:text-foreground'}"
					aria-pressed={uppercase}
					title="Uppercase commands before sending (messages and file names stay as typed)"
					onclick={() => ((uppercase = !uppercase), savePrefs())}><CaseUpper class="size-3.5" />Uppercase {uppercase ? 'on' : 'off'}</button
				>
				{#if currentInfo}
					<span class="flex items-center gap-1 {currentInfo.danger ? 'text-warning' : ''}">
						{#if currentInfo.danger}<TriangleAlert class="size-3" />{/if}<span class="font-mono text-foreground">{currentInfo.code}</span>{currentInfo.danger ?? currentInfo.description}
					</span>
				{:else}
					<span class="kbd-hint"><kbd class="kbd">↵</kbd> send · <kbd class="kbd">⇧↵</kbd> new line · <kbd class="kbd">↑</kbd> history</span>
				{/if}
				{#if live.snapshot.state === 'printing' || live.snapshot.state === 'paused'}
					<span class="ml-auto text-warning">A print is running: you’ll be asked before anything is sent.</span>
				{/if}
			</div>
		</form>
	{:else}
		<div class="flex items-center gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground" data-testid="viewer-hint">
			<Lock class="size-3.5" />Your role can only watch this printer, so the G-code prompt is off.
		</div>
	{/if}
</div>
