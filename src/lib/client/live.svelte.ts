/**
 * A printer's live state in the browser, fed by its Server-Sent Events stream
 * (/api/printers/<id>/events). Create one per printer page:
 *
 *   const live = new LivePrinter(id);   // in a component
 *   onMount(() => live.connect());      // returns the disconnect function
 *   live.snapshot / live.history / live.logs / live.connected
 *   live.on('FileAdded', (payload) => …)  // OctoPrint events, for tabs that refresh on them
 *
 * EventSource reconnects by itself; the first message after a reconnect is a full
 * snapshot, so nothing needs to be stitched together.
 */
import { emptySnapshot, type LiveSnapshot, type TempSample } from '#lib/printer.ts';
import { TempHistory } from '#lib/temp-history.ts';
import { statuses } from './state.svelte.ts';

type Handler = (payload: unknown) => void;

const MAX_LOGS = 1000;

export class LivePrinter {
	readonly id: string;
	snapshot = $state<LiveSnapshot>(emptySnapshot(''));
	/** Bumped whenever `history` changes (the buffer itself isn't reactive). */
	historyVersion = $state(0);
	logs = $state<string[]>([]);
	busyFiles = $state<{ origin: string; path: string }[]>([]);
	/** The SSE stream is open. */
	connected = $state(false);
	/** Server-side push connection state: open means updates arrive in real time. */
	push = $state<string>('idle');
	readonly history: TempHistory;
	private source: EventSource | null = null;
	private handlers = new Map<string, Set<Handler>>();

	constructor(id: string, initial?: LiveSnapshot) {
		this.id = id;
		this.snapshot = initial ?? emptySnapshot(id);
		this.history = new TempHistory(30 * 60_000, 30 * 60 * 2 + 60);
	}

	/** Samples within the last `ms`, oldest first. */
	samples(ms: number): TempSample[] {
		void this.historyVersion;
		const newest = this.history.newest()?.t ?? Date.now();
		return this.history.since(newest - ms);
	}

	/** Subscribes to an OctoPrint event by name (`*` for all, `plugin:<id>` for plugin messages). */
	on(name: string, fn: Handler): () => void {
		let set = this.handlers.get(name);
		if (!set) this.handlers.set(name, (set = new Set()));
		set.add(fn);
		return () => set.delete(fn);
	}

	private fire(name: string, payload: unknown) {
		for (const key of [name, '*']) for (const fn of this.handlers.get(key) ?? []) fn(key === '*' ? { name, payload } : payload);
	}

	private setSnapshot(s: LiveSnapshot) {
		this.snapshot = s;
		statuses[this.id] = s;
	}

	connect(): () => void {
		this.disconnect();
		const es = new EventSource(`/api/printers/${encodeURIComponent(this.id)}/events`);
		this.source = es;
		es.onopen = () => (this.connected = true);
		es.onerror = () => (this.connected = false);
		es.addEventListener('snapshot', (e) => {
			const d = JSON.parse((e as MessageEvent).data) as { snapshot: LiveSnapshot; history: TempSample[]; logs: string[]; busyFiles: LivePrinter['busyFiles']; push: string };
			this.connected = true;
			this.setSnapshot(d.snapshot);
			this.history.clear();
			this.history.merge(d.history);
			this.historyVersion++;
			this.logs = d.logs.slice(-MAX_LOGS);
			this.busyFiles = d.busyFiles;
			this.push = d.push;
		});
		es.addEventListener('update', (e) => {
			const d = JSON.parse((e as MessageEvent).data) as { snapshot: LiveSnapshot; samples: TempSample[]; busyFiles?: LivePrinter['busyFiles'] };
			this.setSnapshot(d.snapshot);
			if (d.snapshot.source === 'push') this.push = 'open';
			if (d.busyFiles) this.busyFiles = d.busyFiles;
			if (d.samples.length) {
				for (const s of d.samples) this.history.push(s);
				this.historyVersion++;
			}
		});
		es.addEventListener('log', (e) => {
			const d = JSON.parse((e as MessageEvent).data) as { lines: string[]; reset: boolean };
			const next = d.reset ? d.lines : [...this.logs, ...d.lines];
			this.logs = next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
		});
		es.addEventListener('octoprint', (e) => {
			const d = JSON.parse((e as MessageEvent).data) as { name: string; payload: unknown };
			this.fire(d.name, d.payload);
		});
		es.addEventListener('plugin', (e) => {
			const d = JSON.parse((e as MessageEvent).data) as { plugin: string; data: unknown };
			this.fire(`plugin:${d.plugin}`, d.data);
		});
		return () => this.disconnect();
	}

	disconnect() {
		this.source?.close();
		this.source = null;
		this.connected = false;
	}
}
