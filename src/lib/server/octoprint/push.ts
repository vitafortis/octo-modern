/**
 * One live connection to OctoPrint's push API (SockJS's raw websocket endpoint,
 * `/sockjs/websocket`, which carries plain JSON frames).
 *
 * Handshake: OctoPrint sends `{"connected": …}` on open; we answer with
 * `{"auth": "<user>:<session>"}` (the session comes from a passive login with the API
 * key) and `{"throttle": N}`. Until the first `current`/`history` frame arrives the
 * session counts as "connecting". Any failure (login refused, socket error, close,
 * no frames for `idleTimeoutMs`) closes the socket and reconnects after a backoff
 * delay, until `stop()`.
 */
import { backoffDelay } from './backoff.ts';
import type { SocketLike } from './transport.ts';

export type PushStatus = 'idle' | 'connecting' | 'open' | 'waiting' | 'stopped';

export interface PushOptions {
	url: string;
	login: () => Promise<{ name: string; session: string }>;
	createSocket: (url: string) => SocketLike;
	/** Every parsed frame (including `connected`). */
	onMessage: (message: unknown) => void;
	/** Status changes; `error` is why the last attempt failed, `retryInMs` when it will retry. */
	onStatus?: (status: PushStatus, info: { attempt: number; error?: unknown; retryInMs?: number }) => void;
	/** OctoPrint sends one update every 500 ms × throttle. */
	throttle?: number;
	backoff?: (attempt: number) => number;
	/** Give up on an attempt that hasn't authenticated within this time. */
	openTimeoutMs?: number;
	/** Reconnect when nothing arrives for this long (OctoPrint sends at least every few seconds). */
	idleTimeoutMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;

export class PushSession {
	private opts: PushOptions;
	private socket: SocketLike | null = null;
	private status: PushStatus = 'idle';
	private attempt = 0;
	private retryTimer: unknown = null;
	private watchdog: unknown = null;
	/** Bumped per attempt so stale callbacks from an old socket are ignored. */
	private generation = 0;
	lastError: unknown = null;
	lastMessageAt = 0;

	constructor(opts: PushOptions) {
		this.opts = opts;
	}

	get state(): PushStatus {
		return this.status;
	}

	get open(): boolean {
		return this.status === 'open';
	}

	/** Failed attempts since the last successful connection. */
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
		this.connect();
	}

	stop() {
		this.generation++;
		this.clearTimer(this.retryTimer);
		this.clearTimer(this.watchdog);
		this.retryTimer = this.watchdog = null;
		const s = this.socket;
		this.socket = null;
		if (s) {
			s.onopen = s.onmessage = s.onclose = s.onerror = null;
			try {
				s.close(1000, 'stopped');
			} catch {}
		}
		this.setStatus('stopped');
	}

	/** Re-arms the watchdog: an attempt that doesn't authenticate, or a connection that goes quiet, is dropped. */
	private arm(ms: number, gen: number, reason: string) {
		this.clearTimer(this.watchdog);
		this.watchdog = this.setTimer(() => {
			if (gen === this.generation) this.fail(new Error(reason), gen);
		}, ms);
	}

	private async connect() {
		const gen = ++this.generation;
		this.setStatus('connecting');
		this.arm(this.opts.openTimeoutMs ?? 15_000, gen, 'Timed out opening the push connection');
		let auth: { name: string; session: string };
		try {
			auth = await this.opts.login();
		} catch (err) {
			if (gen === this.generation) this.fail(err, gen);
			return;
		}
		if (gen !== this.generation) return;
		let socket: SocketLike;
		try {
			socket = this.opts.createSocket(this.opts.url);
		} catch (err) {
			this.fail(err, gen);
			return;
		}
		this.socket = socket;
		socket.onmessage = (ev) => {
			if (gen !== this.generation) return;
			let message: unknown;
			try {
				message = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8'));
			} catch {
				return;
			}
			this.lastMessageAt = Date.now();
			const type = message && typeof message === 'object' ? Object.keys(message)[0] : undefined;
			if (type === 'connected') {
				this.send({ auth: `${auth.name}:${auth.session}` });
				this.send({ throttle: this.opts.throttle ?? 1 });
			} else if (type === 'reauthRequired') {
				// The session expired (or the user changed): log in again on a fresh socket.
				this.fail(new Error('OctoPrint asked to re-authenticate'), gen);
				return;
			} else if ((type === 'current' || type === 'history') && this.status !== 'open') {
				this.attempt = 0;
				this.lastError = null;
				this.setStatus('open');
			}
			if (this.status === 'open') this.arm(this.opts.idleTimeoutMs ?? 30_000, gen, 'The push connection went quiet');
			this.opts.onMessage(message);
		};
		socket.onclose = (ev) => {
			if (gen === this.generation) this.fail(new Error(`Push connection closed${ev?.code ? ` (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})` : ''}`), gen);
		};
		socket.onerror = (ev) => {
			if (gen !== this.generation) return;
			const e = ev as { error?: unknown; message?: string };
			this.fail(e?.error ?? new Error(e?.message || 'Push connection failed'), gen);
		};
	}

	private send(obj: unknown) {
		const s = this.socket;
		if (s && s.readyState === OPEN) s.send(JSON.stringify(obj));
	}

	private fail(error: unknown, gen: number) {
		if (gen !== this.generation) return;
		this.generation++;
		this.clearTimer(this.watchdog);
		this.watchdog = null;
		const s = this.socket;
		this.socket = null;
		if (s) {
			s.onopen = s.onmessage = s.onclose = s.onerror = null;
			try {
				s.close();
			} catch {}
		}
		this.lastError = error;
		const delay = (this.opts.backoff ?? backoffDelay)(this.attempt);
		this.attempt++;
		this.setStatus('waiting', { error, retryInMs: delay });
		this.retryTimer = this.setTimer(() => {
			this.retryTimer = null;
			if (this.status === 'waiting') this.connect();
		}, delay);
	}
}
