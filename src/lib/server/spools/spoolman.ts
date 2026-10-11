/**
 * Spoolman (https://github.com/Donkie/Spoolman), REST API v1: its address and optional
 * auth header (sealed in the store; Spoolman itself has no auth, but a reverse proxy in
 * front of it may), listing spools, and reporting filament use
 * (`PUT /api/v1/spool/{id}/use` with `use_length` in mm).
 */
import { decrypt, encrypt } from '../crypto.ts';
import { getKv, setKv } from '../store.ts';
import { parseSpool, type SpoolmanSettings, type SpoolSummary } from '#lib/spools.ts';

const KEY = 'spoolman:settings';

interface Stored {
	url: string | null;
	authHeader: string | null;
	/** The header's value, sealed. */
	sealed: string | null;
	lowThresholdG: number;
	progressive: boolean;
}

const DEFAULTS: Stored = { url: null, authHeader: null, sealed: null, lowThresholdG: 100, progressive: true };

const load = (): Stored => ({ ...DEFAULTS, ...getKv<Partial<Stored>>(KEY, {}) });

export function spoolmanSettings(): SpoolmanSettings {
	const s = load();
	return { url: s.url, authHeader: s.authHeader, hasAuthValue: !!s.sealed, lowThresholdG: s.lowThresholdG, progressive: s.progressive };
}

export const spoolmanConfigured = () => !!load().url;

/** `http://host:7912` from what an admin pasted (also accepts the …/api/v1 address). */
export function normalizeSpoolmanUrl(raw: string): string {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		throw new Error('Enter Spoolman’s address, like http://spoolman.local:7912');
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Spoolman’s address must start with http:// or https://');
	if (u.username || u.password) throw new Error('Put credentials in the auth header, not the address');
	const path = u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
	return `${u.origin}${path}`;
}

/** Saves the settings; `authValue` undefined or '' keeps the stored value, null clears it. Throws with a message for the user. */
export function saveSpoolmanSettings(b: { url?: unknown; authHeader?: unknown; authValue?: unknown; lowThresholdG?: unknown; progressive?: unknown }): SpoolmanSettings {
	const prev = load();
	const url = typeof b.url === 'string' && b.url.trim() ? normalizeSpoolmanUrl(b.url) : null;
	const header = typeof b.authHeader === 'string' && b.authHeader.trim() ? b.authHeader.trim() : null;
	if (header && !/^[A-Za-z0-9-]{1,64}$/.test(header)) throw new Error('The header name may only have letters, digits and dashes');
	let sealed = prev.sealed;
	if (b.authValue === null || !header) sealed = null;
	else if (typeof b.authValue === 'string' && b.authValue.trim()) {
		if (/[\r\n]/.test(b.authValue)) throw new Error('The header value can’t contain line breaks');
		sealed = encrypt(b.authValue.trim().slice(0, 4000), 'spoolman');
	}
	const low = Number(b.lowThresholdG ?? prev.lowThresholdG);
	if (!Number.isFinite(low) || low < 0 || low > 10_000) throw new Error('The low-spool threshold must be 0–10000 g');
	setKv(KEY, { url, authHeader: header, sealed, lowThresholdG: Math.round(low), progressive: b.progressive === undefined ? prev.progressive : b.progressive !== false } satisfies Stored);
	cache = null;
	return spoolmanSettings();
}

export class SpoolmanError extends Error {
	status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = 'SpoolmanError';
		this.status = status;
	}
}

/** One request to Spoolman's API; JSON in, JSON out. */
async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 8_000): Promise<{ data: T; headers: Headers }> {
	const s = load();
	if (!s.url) throw new SpoolmanError('Spoolman isn’t set up');
	const headers: Record<string, string> = { accept: 'application/json' };
	if (body !== undefined) headers['content-type'] = 'application/json';
	if (s.authHeader && s.sealed) headers[s.authHeader] = decrypt(s.sealed, 'spoolman');
	let res: Response;
	try {
		res = await fetch(`${s.url}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
	} catch (err) {
		const cause = (err as { cause?: { code?: string; message?: string } }).cause;
		const why = (err as Error).name === 'TimeoutError' ? 'timed out' : (cause?.code ?? cause?.message ?? (err as Error).message);
		throw new SpoolmanError(`Can’t reach Spoolman (${why})`);
	}
	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		// Not JSON (a proxy's error page, say).
	}
	if (!res.ok) {
		const msg = data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string' ? (data as { message: string }).message : text.replace(/\s+/g, ' ').trim().slice(0, 160);
		if (res.status === 401 || res.status === 403) throw new SpoolmanError(`Spoolman refused the request (HTTP ${res.status}); check the auth header`, res.status);
		throw new SpoolmanError(`Spoolman answered HTTP ${res.status}${msg ? `: ${msg}` : ''}`, res.status);
	}
	return { data: data as T, headers: res.headers };
}

/** GET /api/v1/info: `{ version, … }`. */
export async function spoolmanInfo(): Promise<{ version: string | null }> {
	const { data } = await call<{ version?: unknown }>('GET', '/info', undefined, 5_000);
	if (!data || typeof data !== 'object') throw new SpoolmanError('That doesn’t look like Spoolman (no /api/v1/info)');
	return { version: typeof data.version === 'string' ? data.version : null };
}

/** Tries the connection: the version and how many spools it has. */
export async function testSpoolman(): Promise<{ version: string | null; spools: number }> {
	const info = await spoolmanInfo();
	const list = await listSpools({ fresh: true });
	return { ...info, spools: list.length };
}

let cache: { at: number; spools: SpoolSummary[] } | null = null;
const CACHE_MS = 30_000;

/** Every spool that isn't archived (cached for 30 s; `fresh` skips the cache). */
export async function listSpools(opts: { fresh?: boolean } = {}): Promise<SpoolSummary[]> {
	if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.spools;
	const { data } = await call<unknown[]>('GET', '/spool?allow_archived=false&sort=id:asc');
	if (!Array.isArray(data)) throw new SpoolmanError('Spoolman’s spool list wasn’t a list');
	const spools = data.map(parseSpool).filter((s): s is SpoolSummary => !!s);
	cache = { at: Date.now(), spools };
	return spools;
}

/** One spool (also archived ones); null when Spoolman doesn't have it (any more). */
export async function getSpool(id: number, opts: { fresh?: boolean } = {}): Promise<SpoolSummary | null> {
	if (!opts.fresh) {
		const hit = cache && Date.now() - cache.at < CACHE_MS ? cache.spools.find((s) => s.id === id) : undefined;
		if (hit) return hit;
	}
	try {
		return parseSpool((await call<unknown>('GET', `/spool/${id}`)).data);
	} catch (err) {
		if (err instanceof SpoolmanError && err.status === 404) return null;
		throw err;
	}
}

/** Several spools by id, from one list request where possible. */
export async function spoolsById(ids: number[]): Promise<Map<number, SpoolSummary>> {
	const out = new Map<number, SpoolSummary>();
	if (!ids.length) return out;
	const list = await listSpools();
	for (const s of list) if (ids.includes(s.id)) out.set(s.id, s);
	for (const id of ids) {
		if (out.has(id)) continue;
		const s = await getSpool(id).catch(() => null); // archived meanwhile
		if (s) out.set(id, s);
	}
	return out;
}

/** Reports `mm` of filament used from a spool; returns the spool as Spoolman has it now. */
export async function useSpool(id: number, mm: number): Promise<SpoolSummary | null> {
	const { data } = await call<unknown>('PUT', `/spool/${id}/use`, { use_length: Math.round(mm * 100) / 100 });
	const spool = parseSpool(data);
	if (spool && cache) cache.spools = cache.spools.map((s) => (s.id === id ? spool : s));
	return spool;
}

/** Forgets the cached spool list (tests). */
export function clearSpoolCache() {
	cache = null;
}
