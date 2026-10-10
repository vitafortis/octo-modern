/**
 * OctoPrint's Application Keys workflow, so admins approve octo·modern in OctoPrint
 * instead of copying keys:
 *
 *   GET  /plugin/appkeys/probe            204 when the plugin is available
 *   POST /plugin/appkeys/request {app}    201 { app_token, auth_dialog }
 *   GET  /plugin/appkeys/request/<token>  202 pending · 200 { api_key } · 404 denied/expired
 *
 * OctoPrint drops a request that isn't polled for 5 seconds, so the server polls (every
 * second) rather than the browser; the browser only watches this request's state. The
 * key stays here until the import saves it, encrypted, and is never sent to the browser.
 */
import { randomUUID } from 'node:crypto';
import { httpFetch } from '../octoprint/transport.ts';
import { errorCode } from '../octoprint/errors.ts';
import type { AppKeyRequestState } from '#lib/discovery.ts';

export const APP_NAME = 'octo·modern';

type Fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }, verifyTls: boolean) => Promise<Response>;

interface Entry extends AppKeyRequestState {
	verifyTls: boolean;
	appToken: string | null;
	apiKey?: string;
	timer?: ReturnType<typeof setTimeout>;
	failures: number;
	deadline: number;
}

export interface AppKeyOptions {
	fetch?: Fetch;
	pollMs?: number;
	/** How long to wait for a decision. */
	timeoutMs?: number;
}

export class AppKeyRequests {
	private entries = new Map<string, Entry>();
	private fetch: Fetch;
	private pollMs: number;
	private timeoutMs: number;

	constructor(opts: AppKeyOptions = {}) {
		this.fetch = opts.fetch ?? ((url, init, verifyTls) => httpFetch(url, init, verifyTls));
		this.pollMs = opts.pollMs ?? 1000;
		this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
	}

	private view(e: Entry): AppKeyRequestState {
		return {
			id: e.id,
			baseUrl: e.baseUrl,
			state: e.state,
			authDialog: e.authDialog,
			message: e.message,
			startedAt: e.startedAt,
			expiresIn: Math.max(0, Math.round((e.deadline - Date.now()) / 1000))
		};
	}

	private call(e: Pick<Entry, 'baseUrl' | 'verifyTls'>, method: string, path: string, body?: unknown) {
		return this.fetch(
			`${e.baseUrl.replace(/\/+$/, '')}${path}`,
			{ method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) },
			e.verifyTls
		);
	}

	/** Asks OctoPrint for a key. Resolves once the request is registered there (or failed). */
	async start(baseUrl: string, { verifyTls = true, user }: { verifyTls?: boolean; user?: string } = {}): Promise<AppKeyRequestState> {
		this.prune();
		const now = Date.now();
		const e: Entry = { id: randomUUID(), baseUrl, verifyTls, appToken: null, authDialog: null, state: 'pending', startedAt: now, expiresIn: 0, failures: 0, deadline: now + this.timeoutMs };
		this.entries.set(e.id, e);
		const fail = (message: string) => {
			e.state = 'error';
			e.message = message;
			return this.view(e);
		};
		try {
			const probe = await this.call(e, 'GET', '/plugin/appkeys/probe');
			if (probe.status !== 204) {
				return fail(
					probe.status === 404
						? 'This OctoPrint doesn’t offer Application Keys (it’s older than 1.3.10 or the plugin is disabled). Paste an API key instead.'
						: `OctoPrint answered the Application Keys probe with ${probe.status}. Paste an API key instead.`
				);
			}
			const res = await this.call(e, 'POST', '/plugin/appkeys/request', { app: APP_NAME, ...(user ? { user } : {}) });
			if (res.status === 429) return fail('OctoPrint limits key requests to 3 a minute. Wait a minute and try again.');
			if (res.status !== 201) return fail(`OctoPrint refused the key request (${res.status}).`);
			const data = (await res.json()) as { app_token?: string; auth_dialog?: string };
			if (!data.app_token) return fail('OctoPrint didn’t return a request token.');
			e.appToken = data.app_token;
			e.authDialog = data.auth_dialog ?? null;
			this.schedule(e);
			return this.view(e);
		} catch (err) {
			const cause = errorCode(err);
			return fail(`Couldn’t reach OctoPrint at ${baseUrl}${cause ? ` (${cause})` : ''}.`);
		}
	}

	private schedule(e: Entry) {
		e.timer = setTimeout(() => void this.poll(e), this.pollMs);
		e.timer.unref?.();
	}

	private async poll(e: Entry) {
		if (e.state !== 'pending' || !e.appToken) return;
		if (Date.now() > e.deadline) {
			e.state = 'expired';
			e.message = 'Nobody approved the request in time. Start again when you’re ready to approve it in OctoPrint.';
			return;
		}
		try {
			const res = await this.call(e, 'GET', `/plugin/appkeys/request/${encodeURIComponent(e.appToken)}`);
			e.failures = 0;
			if (res.status === 200) {
				const data = (await res.json()) as { api_key?: string };
				if (data.api_key) {
					e.apiKey = data.api_key;
					e.state = 'approved';
					e.message = undefined;
					return;
				}
			} else if (res.status === 404) {
				e.state = 'denied';
				e.message = 'The request was denied in OctoPrint (or it expired there).';
				return;
			}
		} catch {
			if (++e.failures >= 10) {
				e.state = 'error';
				e.message = 'Lost contact with OctoPrint while waiting for approval.';
				return;
			}
		}
		if (e.state === 'pending') this.schedule(e);
	}

	status(id: string): AppKeyRequestState | undefined {
		const e = this.entries.get(id);
		return e && this.view(e);
	}

	/** The approved key, when the request was for `baseUrl`. `cancel` it once saved. */
	key(id: string, baseUrl?: string): string | undefined {
		const e = this.entries.get(id);
		if (!e || e.state !== 'approved' || !e.apiKey) return undefined;
		if (baseUrl && baseUrl.replace(/\/+$/, '') !== e.baseUrl.replace(/\/+$/, '')) return undefined;
		return e.apiKey;
	}

	cancel(id: string): boolean {
		const e = this.entries.get(id);
		if (!e) return false;
		clearTimeout(e.timer);
		this.entries.delete(id);
		return true;
	}

	private prune() {
		const cutoff = Date.now() - 30 * 60_000;
		for (const [id, e] of this.entries) if (e.startedAt < cutoff) this.cancel(id);
	}
}

type G = typeof globalThis & { __ocmAppKeys?: AppKeyRequests };
/** One registry per process (survives dev-server module reloads). */
export const appKeys: AppKeyRequests = ((globalThis as G).__ocmAppKeys ??= new AppKeyRequests());
