/**
 * Live state for every printer, shared by all requests in this process.
 *
 * - Printers nobody is watching are polled over REST every `config.pollIntervalMs`
 *   (the sidebar, overview and status API read that).
 * - While someone watches a printer (an open printer page, via SSE), it gets a push
 *   connection; when the last watcher leaves, the connection lingers a minute, then
 *   closes. While the push connection is down (starting, reconnecting, or blocked by
 *   a proxy without websocket support), the printer is polled every 2 s instead.
 */
import { config } from '../config.ts';
import { getApiKey, getPrinter, listPrinters, touchPrinter } from '../store.ts';
import { OctoPrintClient, pushUrl } from './client.ts';
import { OctoPrintError, toOctoPrintError } from './errors.ts';
import { LiveModel, type LiveListener } from './model.ts';
import { PushSession, type PushStatus } from './push.ts';
import { openWebSocket } from './transport.ts';
import type { LiveSnapshot } from '#lib/printer.ts';
import type { Printer } from '#lib/types.ts';

const FAST_POLL_MS = 2_000;
const LINGER_MS = 60_000;
const VERSION_TTL_MS = 30 * 60_000;

/** A REST client for a stored printer, with its decrypted key. */
export function clientFor(printer: Printer | string): OctoPrintClient {
	const p = typeof printer === 'string' ? getPrinter(printer) : printer;
	if (!p) throw new OctoPrintError('Printer not found', { status: 404, code: 'NOT_FOUND' });
	const apiKey = getApiKey(p.id);
	if (!apiKey) {
		throw new OctoPrintError('No API key saved for this server', { code: 'NO_KEY', hint: 'Edit the server and paste an Application Key or a user API key.' });
	}
	return new OctoPrintClient({ baseUrl: p.baseUrl, apiKey, verifyTls: p.verifyTls }, config.requestTimeoutMs);
}

class Entry {
	readonly id: string;
	readonly model: LiveModel;
	/** Signature of the stored settings this entry was built for; an edit rebuilds it. */
	readonly version: string;
	push: PushSession | null = null;
	pushStatus: PushStatus = 'idle';
	watchers = 0;
	lingerTimer: ReturnType<typeof setTimeout> | null = null;
	fastTimer: ReturnType<typeof setInterval> | null = null;
	polling: Promise<void> | null = null;
	lastPollAt = 0;
	versionCheckedAt = 0;

	constructor(id: string, version: string) {
		this.id = id;
		this.version = version;
		this.model = new LiveModel(id, config.tempHistoryMinutes);
	}
}

const signature = (p: Printer) => `${p.baseUrl}|${p.verifyTls}|${p.updatedAt}`;

class PrinterManager {
	private entries = new Map<string, Entry>();

	/** The entry for a stored printer (created on first use, rebuilt after an edit). */
	private entry(id: string): Entry | undefined {
		const printer = getPrinter(id);
		if (!printer) {
			this.forget(id);
			return undefined;
		}
		const existing = this.entries.get(id);
		if (existing && existing.version === signature(printer)) return existing;
		let carried: { watchers: number; listeners: LiveModel } | undefined;
		if (existing) {
			carried = { watchers: existing.watchers, listeners: existing.model };
			this.teardown(existing);
		}
		const e = new Entry(id, signature(printer));
		this.entries.set(id, e);
		if (carried) {
			// Keep the watchers and their listeners: they move to the rebuilt model.
			e.watchers = carried.watchers;
			moveListeners(carried.listeners, e.model);
			if (e.watchers > 0) this.startPush(e);
		}
		return e;
	}

	private teardown(e: Entry) {
		e.push?.stop();
		e.push = null;
		if (e.lingerTimer) clearTimeout(e.lingerTimer);
		if (e.fastTimer) clearInterval(e.fastTimer);
		e.lingerTimer = e.fastTimer = null;
	}

	/** Drops a printer's live state (it was deleted). */
	forget(id: string) {
		const e = this.entries.get(id);
		if (!e) return;
		this.teardown(e);
		this.entries.delete(id);
	}

	snapshot(id: string): LiveSnapshot | undefined {
		return this.entry(id)?.model.snapshot;
	}

	model(id: string): LiveModel | undefined {
		return this.entry(id)?.model;
	}

	pushState(id: string): PushStatus {
		return this.entries.get(id)?.pushStatus ?? 'idle';
	}

	/**
	 * Watches a printer live: the listener gets every change until the returned
	 * function is called. Opens the push connection if this is the first watcher.
	 */
	subscribe(id: string, listener: LiveListener): () => void {
		const e = this.entry(id);
		if (!e) throw new OctoPrintError('Printer not found', { status: 404, code: 'NOT_FOUND' });
		const off = e.model.on(listener);
		const unwatch = this.watch(id);
		return () => {
			off();
			// The entry may have been rebuilt meanwhile; its listeners moved with it.
			this.entries.get(id)?.model.off(listener);
			unwatch();
		};
	}

	/** Keeps a printer live (push connection) without a listener, e.g. for a background job. */
	watch(id: string): () => void {
		const e = this.entry(id);
		if (!e) return () => {};
		e.watchers++;
		if (e.lingerTimer) {
			clearTimeout(e.lingerTimer);
			e.lingerTimer = null;
		}
		this.startPush(e);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const cur = this.entries.get(id);
			if (!cur) return;
			cur.watchers = Math.max(0, cur.watchers - 1);
			if (cur.watchers === 0 && !cur.lingerTimer) {
				cur.lingerTimer = setTimeout(() => {
					cur.lingerTimer = null;
					if (cur.watchers === 0) this.stopPush(cur);
				}, LINGER_MS);
				cur.lingerTimer.unref?.();
			}
		};
	}

	private startPush(e: Entry) {
		if (e.push) return;
		let client: OctoPrintClient;
		try {
			client = clientFor(e.id);
		} catch (err) {
			e.model.setProblem(toOctoPrintError(err));
			return;
		}
		const verifyTls = client.target.verifyTls;
		e.push = new PushSession({
			url: pushUrl(client.target.baseUrl),
			throttle: config.pushThrottle,
			login: () => client.passiveLogin(),
			createSocket: (url) => openWebSocket(url, verifyTls),
			onMessage: (m) => {
				const type = e.model.applyPush(m);
				if (type === 'connected' && e.model.snapshot.version) touchPrinter(e.id, e.model.snapshot.version);
			},
			onStatus: (status, info) => {
				e.pushStatus = status;
				if (status === 'open') {
					this.stopFastPoll(e);
					touchPrinter(e.id, e.model.snapshot.version);
				} else if (status === 'waiting' || status === 'connecting') {
					this.startFastPoll(e);
					if (status === 'waiting' && info.attempt >= 3 && info.attempt % 5 === 3) {
						console.warn(`[octo-modern] push for printer ${e.id} still failing (${(info.error as Error)?.message ?? info.error}); polling instead`);
					}
				}
			}
		});
		e.push.start();
	}

	private stopPush(e: Entry) {
		e.push?.stop();
		e.push = null;
		e.pushStatus = 'idle';
		this.stopFastPoll(e);
	}

	private startFastPoll(e: Entry) {
		if (e.fastTimer) return;
		void this.poll(e.id);
		e.fastTimer = setInterval(() => {
			if (e.push?.open || e.watchers === 0) return;
			void this.poll(e.id);
		}, FAST_POLL_MS);
		e.fastTimer.unref?.();
	}

	private stopFastPoll(e: Entry) {
		if (e.fastTimer) clearInterval(e.fastTimer);
		e.fastTimer = null;
	}

	/** Polls one printer over REST now (shared with any poll already running). */
	poll(id: string): Promise<void> {
		const e = this.entry(id);
		if (!e) return Promise.resolve();
		if (e.polling) return e.polling;
		e.polling = (async () => {
			try {
				const client = clientFor(id);
				const needVersion = Date.now() - e.versionCheckedAt > VERSION_TTL_MS || !e.model.snapshot.version;
				const [printer, job, version] = await Promise.all([
					client.printer(),
					client.job(),
					needVersion ? client.version().then((v) => v.server) : Promise.resolve(null)
				]);
				if (version) e.versionCheckedAt = Date.now();
				// A push update may have landed meanwhile; it's fresher than this poll.
				if (e.push?.open) return;
				e.model.applyPoll({ printer, job, version });
				touchPrinter(id, version);
			} catch (err) {
				if (!e.push?.open) e.model.setProblem(toOctoPrintError(err));
			} finally {
				e.lastPollAt = Date.now();
				e.polling = null;
			}
		})();
		return e.polling;
	}

	/**
	 * Refreshes printers that aren't live: called by the background job, and by
	 * readers so data is never much older than the poll interval even without it.
	 */
	async pollStale(maxAgeMs = config.pollIntervalMs, ids?: string[]): Promise<void> {
		const now = Date.now();
		const targets = (ids ?? listPrinters().map((p) => p.id))
			.map((id) => this.entry(id))
			.filter((e): e is Entry => !!e && !e.push?.open && now - e.lastPollAt >= maxAgeMs);
		await Promise.all(targets.map((e) => this.poll(e.id)));
	}

	/** Snapshots of the given printers, polling any that were never polled or are stale (waits up to `waitMs`). */
	async snapshots(ids: string[], waitMs = 4_000): Promise<LiveSnapshot[]> {
		const fresh = this.pollStale(config.pollIntervalMs, ids);
		const neverSeen = ids.some((id) => (this.entry(id)?.model.snapshot.source ?? 'none') === 'none' && this.entry(id)?.model.snapshot.state !== 'offline');
		if (neverSeen) await Promise.race([fresh, new Promise((r) => setTimeout(r, waitMs))]);
		return ids.map((id) => this.entry(id)?.model.snapshot).filter((s): s is LiveSnapshot => !!s);
	}
}

/** Moves listeners from a model being replaced (after an edit) to its successor. */
function moveListeners(from: LiveModel, to: LiveModel) {
	for (const fn of from.takeListeners()) to.on(fn);
}

const KEY = Symbol.for('octo-modern.printer-manager');
type G = typeof globalThis & { [KEY]?: PrinterManager };

/** The process-wide manager (survives dev-server module reloads). */
export const printers: PrinterManager = ((globalThis as G)[KEY] ??= new PrinterManager());
