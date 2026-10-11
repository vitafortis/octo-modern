/**
 * Live state from Moonraker.
 *
 * - `MoonrakerFeed` keeps one printer's Klipper status (all subscribed objects, merged
 *   from every update), turns it into the LiveModel's snapshot, temperature samples and
 *   terminal lines, and synthesizes OctoPrint-style print events from print_stats
 *   changes. Both the websocket and REST polling feed it, so the history, notifications
 *   and queue see the same thing either way.
 * - `MoonrakerSession` is the websocket (JSON-RPC 2.0 on `/websocket`): identify,
 *   `printer.objects.subscribe`, then `notify_status_update` diffs. It reconnects with
 *   backoff like the OctoPrint push session, and has the same public surface so the
 *   manager can treat both alike (polling covers the gaps while it's down).
 * - `pollMoonraker` is the REST fallback: `server.info` and `printer.objects.query`.
 */
import { backoffDelay } from '../octoprint/backoff.ts';
import type { LiveModel } from '../octoprint/model.ts';
import type { PushStatus } from '../octoprint/push.ts';
import type { SocketLike } from '../octoprint/transport.ts';
import type { MoonrakerClient } from './client.ts';
import {
	heaterMap,
	klippyOf,
	logLines,
	mergeStatus,
	parseMeta,
	PrintTransitions,
	sampleFrom,
	samplesFromStore,
	snapshotFromStatus,
	subscription,
	versionText,
	type FileMeta,
	type HeaterRef,
	type Klippy,
	type Status
} from './parse.ts';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const SAMPLE_EVERY_MS = 1_000;

export interface ReadyInfo {
	klippy: Klippy;
	objects: string[];
	status: Status;
	version?: string | null;
	/** `server.temperature_store`, to fill the chart's history. */
	tempStore?: unknown;
	/** `server.gcode_store`, the terminal backlog. */
	gcodeStore?: unknown;
}

export class MoonrakerFeed {
	readonly model: LiveModel;
	status: Status = {};
	klippy: Klippy = { state: 'disconnected', message: null };
	objects: string[] = [];
	map: Record<string, HeaterRef> = {};
	version: string | null = null;
	private transitions = new PrintTransitions();
	private meta = new Map<string, FileMeta | null>();
	private loadingMeta = new Set<string>();
	private lastSampleAt = 0;
	private lastTargets = '';
	private fetchMeta: (path: string) => Promise<unknown>;
	private now: () => number;

	constructor(model: LiveModel, fetchMeta: (path: string) => Promise<unknown>, now: () => number = Date.now) {
		this.model = model;
		this.fetchMeta = fetchMeta;
		this.now = now;
	}

	/** Klipper is ready and subscribed: replace the status (and, given, the history and log backlog). */
	ready(info: ReadyInfo, source: 'push' | 'poll') {
		this.klippy = info.klippy;
		this.objects = info.objects;
		this.map = heaterMap(info.objects);
		this.status = mergeStatus({}, info.status);
		if (info.version) this.version = info.version;
		const history = info.tempStore ? samplesFromStore(info.tempStore, this.map, this.now()) : undefined;
		if (info.gcodeStore !== undefined) this.model.addLogs(logLines(info.gcodeStore), true);
		this.commit(source, history);
	}

	/** A `notify_status_update` diff (or a poll's full status). */
	update(diff: unknown, source: 'push' | 'poll') {
		mergeStatus(this.status, diff);
		this.commit(source);
	}

	/** Klippy changed state (shutdown, disconnected, startup) while Moonraker stays up. */
	setKlippy(k: Klippy, source: 'push' | 'poll') {
		this.klippy = k;
		if (k.state !== 'ready') this.status.webhooks = { state: k.state, state_message: k.message ?? '' };
		this.commit(source);
	}

	log(lines: string[]) {
		this.model.addLogs(lines);
	}

	/** Commands octo·modern itself sent (Moonraker doesn't echo them), for the terminal. */
	sent(script: string) {
		this.model.addLogs(script.split('\n').filter(Boolean).map((l) => `Send: ${l}`));
	}

	event(name: string, payload: unknown = null) {
		this.model.emitEvent(name, payload);
	}

	private metaFor(path: string | null): FileMeta | null {
		if (!path) return null;
		if (this.meta.has(path)) return this.meta.get(path) ?? null;
		if (!this.loadingMeta.has(path)) {
			this.loadingMeta.add(path);
			this.fetchMeta(path)
				.then((raw) => this.meta.set(path, raw ? parseMeta(raw, path) : null))
				.catch(() => this.meta.set(path, null))
				.finally(() => {
					this.loadingMeta.delete(path);
					if (this.meta.size > 50) this.meta.delete(this.meta.keys().next().value!);
					// Fill in the estimate and filament now that they're known.
					if (str(this.status.print_stats?.filename) === path) this.commit(this.model.snapshot.source === 'poll' ? 'poll' : 'push');
				});
		}
		return null;
	}

	/** Forget cached metadata (the file was replaced). */
	forgetMeta(path?: string) {
		if (path) this.meta.delete(path);
		else this.meta.clear();
	}

	private commit(source: 'push' | 'poll', history?: ReturnType<typeof samplesFromStore>) {
		const klippy = klippyOf(this.status, this.klippy);
		const filename = str(this.status.print_stats?.filename);
		const next = snapshotFromStatus(this.status, klippy, this.map, this.metaFor(filename));
		const now = this.now();
		const samples = [];
		const temps = next.temps ?? {};
		const targets = JSON.stringify(Object.values(temps).map((t) => t.target));
		if (Object.keys(temps).length && (now - this.lastSampleAt >= SAMPLE_EVERY_MS || targets !== this.lastTargets)) {
			samples.push(sampleFrom(temps, now));
			this.lastSampleAt = now;
			this.lastTargets = targets;
		}
		if (this.version) next.version = this.version;
		this.model.applyLive({ ...next, source }, { samples, history }, now);
		for (const e of this.transitions.next(this.status, klippy)) this.model.emitEvent(e.name, e.payload);
	}
}

// --- websocket -------------------------------------------------------------------------

export interface SessionOptions {
	/** The websocket URL, with a fresh one-shot token when an API key is set. */
	url: () => Promise<string>;
	createSocket: (url: string) => SocketLike;
	feed: MoonrakerFeed;
	onStatus?: (status: PushStatus, info: { attempt: number; error?: unknown; retryInMs?: number }) => void;
	backoff?: (attempt: number) => number;
	openTimeoutMs?: number;
	/** Reconnect when nothing arrives for this long (a keepalive call goes out every `keepaliveMs`). */
	idleTimeoutMs?: number;
	keepaliveMs?: number;
	/** While Klippy isn't ready, ask Moonraker again this often. */
	recheckMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;

export class MoonrakerSession {
	private opts: SessionOptions;
	private socket: SocketLike | null = null;
	private status: PushStatus = 'idle';
	private attempt = 0;
	private retryTimer: unknown = null;
	private watchdog: unknown = null;
	private keepalive: unknown = null;
	private recheck: unknown = null;
	private generation = 0;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
	private settingUp = false;
	lastError: unknown = null;

	constructor(opts: SessionOptions) {
		this.opts = opts;
	}

	get state(): PushStatus {
		return this.status;
	}

	get open(): boolean {
		return this.status === 'open';
	}

	get failures(): number {
		return this.attempt;
	}

	private setTimer(fn: () => void, ms: number) {
		return (this.opts.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
	}

	private clearTimer(h: unknown) {
		if (h != null) (this.opts.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(h);
	}

	private setStatus(status: PushStatus, info: { error?: unknown; retryInMs?: number } = {}) {
		this.status = status;
		this.opts.onStatus?.(status, { attempt: this.attempt, ...info });
	}

	start() {
		if (this.status === 'connecting' || this.status === 'open' || this.status === 'waiting') return;
		void this.connect();
	}

	stop() {
		this.generation++;
		this.clearAll();
		this.closeSocket(1000, 'stopped');
		this.setStatus('stopped');
	}

	private clearAll() {
		for (const h of [this.retryTimer, this.watchdog, this.keepalive, this.recheck]) this.clearTimer(h);
		this.retryTimer = this.watchdog = this.keepalive = this.recheck = null;
		for (const p of this.pending.values()) p.reject(new Error('Connection closed'));
		this.pending.clear();
	}

	private closeSocket(code?: number, reason?: string) {
		const s = this.socket;
		this.socket = null;
		if (s) {
			s.onopen = s.onmessage = s.onclose = s.onerror = null;
			try {
				s.close(code, reason);
			} catch {}
		}
	}

	private arm(ms: number, gen: number, reason: string) {
		this.clearTimer(this.watchdog);
		this.watchdog = this.setTimer(() => {
			if (gen === this.generation) this.fail(new Error(reason), gen);
		}, ms);
	}

	/** One JSON-RPC call over the socket. */
	call<T = unknown>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
		const s = this.socket;
		if (!s || s.readyState !== OPEN) return Promise.reject(new Error('Not connected'));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = this.setTimer(() => {
				if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => (this.clearTimer(timer), resolve(v as T)),
				reject: (e) => (this.clearTimer(timer), reject(e))
			});
			s.send(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}), id }));
		});
	}

	private async connect() {
		const gen = ++this.generation;
		this.setStatus('connecting');
		this.arm(this.opts.openTimeoutMs ?? 15_000, gen, 'Timed out opening the Moonraker websocket');
		let url: string;
		try {
			url = await this.opts.url();
		} catch (err) {
			if (gen === this.generation) this.fail(err, gen);
			return;
		}
		if (gen !== this.generation) return;
		let socket: SocketLike;
		try {
			socket = this.opts.createSocket(url);
		} catch (err) {
			this.fail(err, gen);
			return;
		}
		this.socket = socket;
		socket.onopen = () => {
			if (gen !== this.generation) return;
			void this.setup(gen, true);
		};
		socket.onmessage = (ev) => {
			if (gen !== this.generation) return;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8'));
			} catch {
				return;
			}
			if (this.status === 'open') this.arm(this.opts.idleTimeoutMs ?? 60_000, gen, 'The Moonraker websocket went quiet');
			this.onMessage(msg, gen);
		};
		socket.onclose = (ev) => {
			if (gen === this.generation) this.fail(new Error(`Moonraker websocket closed${ev?.code ? ` (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})` : ''}`), gen);
		};
		socket.onerror = (ev) => {
			if (gen !== this.generation) return;
			const e = ev as { error?: unknown; message?: string };
			this.fail(e?.error ?? new Error(e?.message || 'Moonraker websocket failed'), gen);
		};
	}

	private onMessage(msg: Record<string, unknown>, gen: number) {
		if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
			const p = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			const err = msg.error as { message?: string; code?: number } | undefined;
			if (err) p.reject(Object.assign(new Error(err.message ?? 'Moonraker error'), { rpcCode: err.code }));
			else p.resolve(msg.result);
			return;
		}
		const method = msg.method;
		const params = Array.isArray(msg.params) ? msg.params : [];
		const feed = this.opts.feed;
		switch (method) {
			case 'notify_status_update':
				if (this.status === 'open' && feed.klippy.state === 'ready') feed.update(params[0], 'push');
				return;
			case 'notify_gcode_response':
				feed.log(params.filter((l): l is string => typeof l === 'string').flatMap((l) => l.split('\n')).map((l) => `Recv: ${l}`));
				return;
			case 'notify_klippy_ready':
				void this.setup(gen, false);
				return;
			case 'notify_klippy_shutdown':
				feed.setKlippy({ state: 'shutdown', message: null }, 'push');
				this.scheduleRecheck(gen, 500);
				return;
			case 'notify_klippy_disconnected':
				feed.setKlippy({ state: 'disconnected', message: null }, 'push');
				this.scheduleRecheck(gen);
				return;
			case 'notify_filelist_changed': {
				const p = params[0] as { action?: string; item?: { path?: string } } | undefined;
				if (p?.item?.path) feed.forgetMeta(p.item.path);
				feed.event('UpdatedFiles', { target: 'local', action: p?.action ?? null, path: p?.item?.path ?? null });
				return;
			}
			default:
				return;
		}
	}

	/** Identify, read Klippy's state, subscribe. Runs on open and whenever Klippy becomes ready again. */
	private async setup(gen: number, first: boolean) {
		if (this.settingUp) return;
		this.settingUp = true;
		try {
			if (first) {
				await this.call('server.connection.identify', { client_name: 'octo-modern', version: '0.1.0', type: 'other', url: 'https://github.com/vitafortis/octo-modern' }).catch(() => null);
			}
			const info = (await this.call<Record<string, unknown>>('server.info')) ?? {};
			if (gen !== this.generation) return;
			const klippyState = str(info.klippy_state) ?? (info.klippy_connected === false ? 'disconnected' : 'ready');
			let pinfo: Record<string, unknown> = {};
			if (klippyState !== 'disconnected') pinfo = (await this.call<Record<string, unknown>>('printer.info').catch(() => ({}))) ?? {};
			const version = versionText(pinfo.software_version, info.moonraker_version);
			const klippy: Klippy = { state: str(pinfo.state) ?? klippyState, message: str(pinfo.state_message) };
			if (klippy.state !== 'ready') {
				if (version) this.opts.feed.version = version;
				this.opts.feed.setKlippy(klippy, 'push');
				this.markOpen(gen);
				this.scheduleRecheck(gen);
				return;
			}
			const objects = ((await this.call<{ objects?: string[] }>('printer.objects.list'))?.objects ?? []).filter((o) => typeof o === 'string');
			const sub = await this.call<{ status?: Status }>('printer.objects.subscribe', { objects: subscription(objects) });
			const [tempStore, gcodeStore] = await Promise.all([
				first ? this.call('server.temperature_store', { include_monitors: false }).catch(() => undefined) : Promise.resolve(undefined),
				first ? this.call('server.gcode_store', { count: 100 }).catch(() => undefined) : Promise.resolve(undefined)
			]);
			if (gen !== this.generation) return;
			this.markOpen(gen);
			this.opts.feed.ready({ klippy, objects, status: sub?.status ?? {}, version, tempStore, gcodeStore }, 'push');
		} catch (err) {
			if (gen === this.generation) this.fail(err, gen);
		} finally {
			this.settingUp = false;
		}
	}

	private markOpen(gen: number) {
		if (this.status !== 'open') {
			this.attempt = 0;
			this.lastError = null;
			this.setStatus('open');
		}
		this.arm(this.opts.idleTimeoutMs ?? 60_000, gen, 'The Moonraker websocket went quiet');
		if (!this.keepalive) {
			const tick = () => {
				this.keepalive = this.setTimer(() => {
					if (gen !== this.generation) return;
					this.call('server.info').catch(() => {});
					tick();
				}, this.opts.keepaliveMs ?? 20_000);
			};
			tick();
		}
	}

	/** While Klippy isn't ready: ask again until it is (Moonraker announces ready, but not every error). */
	private scheduleRecheck(gen: number, ms = this.opts.recheckMs ?? 3_000) {
		this.clearTimer(this.recheck);
		this.recheck = this.setTimer(async () => {
			this.recheck = null;
			if (gen !== this.generation) return;
			try {
				const info = (await this.call<Record<string, unknown>>('server.info')) ?? {};
				const state = str(info.klippy_state) ?? 'disconnected';
				if (state === 'ready') return void this.setup(gen, false);
				const pinfo: Record<string, unknown> = state !== 'disconnected' ? ((await this.call<Record<string, unknown>>('printer.info').catch(() => ({}))) ?? {}) : {};
				const k: Klippy = { state: str(pinfo.state) ?? state, message: str(pinfo.state_message) };
				if (k.state === 'ready') return void this.setup(gen, false);
				if (k.state !== this.opts.feed.klippy.state || k.message !== this.opts.feed.klippy.message) this.opts.feed.setKlippy(k, 'push');
			} catch {}
			if (gen === this.generation) this.scheduleRecheck(gen);
		}, ms);
	}

	private fail(error: unknown, gen: number) {
		if (gen !== this.generation) return;
		this.generation++;
		this.clearAll();
		this.closeSocket();
		this.lastError = error;
		const delay = (this.opts.backoff ?? backoffDelay)(this.attempt);
		this.attempt++;
		this.setStatus('waiting', { error, retryInMs: delay });
		this.retryTimer = this.setTimer(() => {
			this.retryTimer = null;
			if (this.status === 'waiting') void this.connect();
		}, delay);
	}
}

// --- REST polling --------------------------------------------------------------------------

/** One REST poll into the feed: `server.info`, then (when Klipper is ready) the subscribed objects. */
export async function pollMoonraker(client: MoonrakerClient, feed: MoonrakerFeed, opts: { refreshInfo?: boolean } = {}): Promise<void> {
	const info = await client.serverInfo();
	const state = str(info?.klippy_state) ?? (info?.klippy_connected === false ? 'disconnected' : 'ready');
	let pinfo: Record<string, unknown> = {};
	if (state !== 'disconnected' && (opts.refreshInfo || state !== 'ready' || !feed.version)) pinfo = (await client.printerInfo().catch(() => ({}))) ?? {};
	const version = versionText(pinfo.software_version, info?.moonraker_version);
	if (version && (pinfo.software_version || !feed.version)) feed.version = version;
	const klippy: Klippy = { state: str(pinfo.state) ?? state, message: str(pinfo.state_message) };
	if (klippy.state !== 'ready') return feed.setKlippy(klippy, 'poll');
	if (!feed.objects.length || opts.refreshInfo) feed.objects = ((await client.objectList())?.objects ?? []).filter((o) => typeof o === 'string');
	const q = await client.query(subscription(feed.objects));
	const first = feed.klippy.state !== 'ready' || !Object.keys(feed.status).length;
	if (first) feed.ready({ klippy, objects: feed.objects, status: q?.status ?? {}, version }, 'poll');
	else {
		feed.klippy = klippy;
		feed.update(q?.status ?? {}, 'poll');
	}
}
