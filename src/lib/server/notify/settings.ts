/**
 * Stored notification settings: channels (secrets sealed per channel), routing rules
 * and the general options. One kv entry, `notify:settings`. The settings of the first
 * version (`history:notifications`: ntfy / Discord / webhook per print outcome) are
 * migrated on first read: each channel keeps its id and sealed secrets, and gets a rule
 * with the outcomes it was subscribed to.
 */
import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '../crypto.ts';
import { deleteKv, getKv, setKv } from '../store.ts';
import {
	CHANNEL_TYPE_MAP,
	DEFAULT_GENERAL,
	DEFAULT_QUIET,
	EVENT_KINDS,
	isChannelType,
	type ChannelInfo,
	type ChannelType,
	type EventKind,
	type GeneralSettings,
	type QuietHours,
	type Rule
} from '#lib/notify.ts';
import { ADAPTERS } from './channels/index.ts';

export const KEY = 'notify:settings';
export const LEGACY_KEY = 'history:notifications';
export const MAX_CHANNELS = 30;
export const MAX_RULES = 50;

export interface StoredChannel {
	id: string;
	type: ChannelType;
	name: string;
	enabled: boolean;
	config: Record<string, string>;
	/** Secrets, sealed with the context `notify:<id>`. */
	sealed: string | null;
	quiet: QuietHours;
	lastError: string | null;
	lastSentAt: string | null;
}

export interface Stored extends GeneralSettings {
	version: 2;
	channels: StoredChannel[];
	rules: Rule[];
}

export class SettingsError extends Error {}

const fresh = (): Stored => ({ version: 2, ...structuredClone(DEFAULT_GENERAL), channels: [], rules: [] });

interface LegacyChannel {
	id: string;
	kind: 'ntfy' | 'discord' | 'webhook';
	name: string;
	enabled: boolean;
	on: ('success' | 'failed' | 'cancelled' | 'failure.suspected')[];
	config: Record<string, string>;
	sealed: string | null;
	lastError: string | null;
	lastSentAt: string | null;
}

const LEGACY_EVENT: Record<string, EventKind> = { success: 'print.finished', failed: 'print.failed', cancelled: 'print.cancelled', 'failure.suspected': 'failure.suspected' };

/** The first version's settings in today's shape (pure; exported for tests). */
export function migrateLegacy(old: { channels?: LegacyChannel[]; publicUrl?: string | null }): Stored {
	const s = fresh();
	s.publicUrl = old.publicUrl ?? null;
	for (const c of old.channels ?? []) {
		if (!isChannelType(c.kind)) continue;
		s.channels.push({
			id: c.id,
			type: c.kind,
			name: c.name,
			enabled: c.enabled !== false,
			// Webhooks keep the payload they were built against.
			config: { ...c.config, ...(c.kind === 'webhook' ? { format: '1' } : {}) },
			sealed: c.sealed,
			quiet: { ...DEFAULT_QUIET },
			lastError: c.lastError ?? null,
			lastSentAt: c.lastSentAt ?? null
		});
		const events = (c.on ?? []).map((r) => LEGACY_EVENT[r]).filter(Boolean);
		if (events.length) s.rules.push({ id: randomUUID(), name: c.name, enabled: true, printers: 'all', events, channels: [c.id] });
	}
	return s;
}

export function load(): Stored {
	const s = getKv<Stored | null>(KEY, null);
	if (s) return { ...fresh(), ...s, hot: { ...DEFAULT_GENERAL.hot, ...s.hot } };
	const legacy = getKv<{ channels?: LegacyChannel[]; publicUrl?: string | null } | null>(LEGACY_KEY, null);
	if (!legacy) return fresh();
	const migrated = migrateLegacy(legacy);
	setKv(KEY, migrated);
	deleteKv(LEGACY_KEY);
	console.log(`[octo-modern] notifications: migrated ${migrated.channels.length} channel(s) to the new settings`);
	return migrated;
}

export function save(s: Stored) {
	setKv(KEY, s);
}

export const secretsOf = (c: Pick<StoredChannel, 'id' | 'sealed'>): Record<string, string> => (c.sealed ? JSON.parse(decrypt(c.sealed, `notify:${c.id}`)) : {});
export const seal = (id: string, secrets: Record<string, string>) => (Object.keys(secrets).length ? encrypt(JSON.stringify(secrets), `notify:${id}`) : null);

/** A safe-to-show hint for a secret: the host of a URL, or that it's set. */
export function secretHint(value: string): string {
	try {
		const u = new URL(value);
		if (/^https?:$/.test(u.protocol)) return `${u.host}/…`;
	} catch {}
	return '••••••';
}

export function channelInfo(c: StoredChannel): ChannelInfo {
	let secrets: Record<string, string> = {};
	try {
		secrets = Object.fromEntries(Object.entries(secretsOf(c)).map(([k, v]) => [k, secretHint(v)]));
	} catch {
		secrets = {};
	}
	return { id: c.id, type: c.type, name: c.name, enabled: c.enabled, config: c.config, secrets, quiet: c.quiet, lastError: c.lastError, lastSentAt: c.lastSentAt };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseQuiet(raw: unknown): QuietHours {
	const q = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const out: QuietHours = { ...DEFAULT_QUIET };
	out.enabled = q.enabled === true;
	if (typeof q.start === 'string' && HHMM.test(q.start)) out.start = q.start;
	else if (out.enabled) throw new SettingsError('Quiet hours: the start is a time like 22:00');
	if (typeof q.end === 'string' && HHMM.test(q.end)) out.end = q.end;
	else if (out.enabled) throw new SettingsError('Quiet hours: the end is a time like 07:00');
	out.days = Array.isArray(q.days) ? [...new Set(q.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))].sort() : [];
	out.allowCritical = q.allowCritical !== false;
	return out;
}

/**
 * A channel from the editor, validated. Secrets left empty keep the stored ones (of the
 * same type); `clear` lists secrets to remove. Throws a SettingsError for the user.
 */
export function parseChannel(raw: unknown, prev: StoredChannel | undefined): { channel: StoredChannel; secrets: Record<string, string> } {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const type = o.type ?? prev?.type;
	if (!isChannelType(type)) throw new SettingsError('Choose a channel type');
	const info = CHANNEL_TYPE_MAP[type];
	const id = prev?.id ?? randomUUID();
	const oldSecrets = prev && prev.type === type ? secretsOf(prev) : {};
	const inConfig = (o.config && typeof o.config === 'object' ? o.config : {}) as Record<string, unknown>;
	const inSecrets = (o.secrets && typeof o.secrets === 'object' ? o.secrets : {}) as Record<string, unknown>;
	const clear = new Set(Array.isArray(o.clear) ? o.clear.filter((x) => typeof x === 'string') : []);
	const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : info.label;
	const config: Record<string, string> = {};
	const secrets: Record<string, string> = {};
	for (const f of info.fields) {
		if (f.kind === 'secret') {
			const v = typeof inSecrets[f.key] === 'string' ? (inSecrets[f.key] as string).trim() : '';
			if (v) secrets[f.key] = v.slice(0, 2000);
			else if (oldSecrets[f.key] && !clear.has(f.key)) secrets[f.key] = oldSecrets[f.key];
			if (f.required && !secrets[f.key]) throw new SettingsError(`${name}: ${f.label} is required`);
			continue;
		}
		let v = inConfig[f.key];
		if (f.kind === 'toggle') {
			if (v === true || v === 'true') config[f.key] = 'true';
			continue;
		}
		if (typeof v === 'number') v = String(v);
		const s = typeof v === 'string' ? v.trim().slice(0, 500) : '';
		if (s) {
			if (f.kind === 'url' && !/^https?:\/\/[^\s/]+/i.test(s)) throw new SettingsError(`${name}: ${f.label} must be an http(s) URL`);
			if (f.kind === 'number' && !/^\d{1,6}$/.test(s)) throw new SettingsError(`${name}: ${f.label} must be a number`);
			if (f.kind === 'select' && !f.options?.some((x) => x.value === s)) throw new SettingsError(`${name}: unknown ${f.label}`);
			config[f.key] = s;
		} else if (f.required) throw new SettingsError(`${name}: ${f.label} is required`);
	}
	const problem = ADAPTERS[type].validate?.(config, secrets);
	if (problem) throw new SettingsError(`${name}: ${problem}`);
	return {
		channel: {
			id,
			type,
			name,
			enabled: o.enabled !== false,
			config,
			sealed: null,
			quiet: parseQuiet(o.quiet ?? prev?.quiet),
			lastError: prev?.type === type ? prev.lastError : null,
			lastSentAt: prev?.type === type ? prev.lastSentAt : null
		},
		secrets
	};
}

export function listChannels(): ChannelInfo[] {
	return load().channels.map(channelInfo);
}

export function createChannel(raw: unknown): ChannelInfo {
	const s = load();
	if (s.channels.length >= MAX_CHANNELS) throw new SettingsError(`At most ${MAX_CHANNELS} channels`);
	const { channel, secrets } = parseChannel(raw, undefined);
	channel.sealed = seal(channel.id, secrets);
	s.channels.push(channel);
	save(s);
	return channelInfo(channel);
}

export function updateChannel(id: string, raw: unknown): ChannelInfo | null {
	const s = load();
	const i = s.channels.findIndex((c) => c.id === id);
	if (i < 0) return null;
	const { channel, secrets } = parseChannel(raw, s.channels[i]);
	channel.sealed = seal(channel.id, secrets);
	s.channels[i] = channel;
	save(s);
	return channelInfo(channel);
}

/** Removes a channel, and it from every rule. */
export function deleteChannel(id: string): StoredChannel | null {
	const s = load();
	const c = s.channels.find((x) => x.id === id);
	if (!c) return null;
	s.channels = s.channels.filter((x) => x.id !== id);
	for (const r of s.rules) r.channels = r.channels.filter((x) => x !== id);
	save(s);
	return c;
}

const num = (v: unknown, min: number, max: number, fallback: number) => {
	const n = typeof v === 'string' && v.trim() ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function numList(v: unknown, min: number, max: number, what: string): number[] {
	const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/).filter(Boolean) : [];
	const out = items.map((x) => Number(x));
	if (out.some((n) => !Number.isFinite(n) || n < min || n > max)) throw new SettingsError(`${what}: numbers from ${min} to ${max}`);
	return [...new Set(out.map((n) => Math.round(n * 10) / 10))].sort((a, b) => a - b).slice(0, 10);
}

export function parseRules(raw: unknown, channelIds: Set<string>): Rule[] {
	if (!Array.isArray(raw)) throw new SettingsError('"rules" must be a list');
	if (raw.length > MAX_RULES) throw new SettingsError(`At most ${MAX_RULES} rules`);
	return raw.map((r, i) => {
		const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
		const events = Array.isArray(o.events) ? EVENT_KINDS.filter((k) => (o.events as unknown[]).includes(k)) : [];
		const channels = Array.isArray(o.channels) ? [...new Set(o.channels.filter((c): c is string => typeof c === 'string' && channelIds.has(c)))] : [];
		const printers = o.printers === 'all' || !Array.isArray(o.printers) ? 'all' : [...new Set(o.printers.filter((p): p is string => typeof p === 'string'))].slice(0, 200);
		return {
			id: typeof o.id === 'string' && /^[\w-]{1,64}$/.test(o.id) ? o.id : randomUUID(),
			name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : `Rule ${i + 1}`,
			enabled: o.enabled !== false,
			printers,
			events,
			channels
		};
	});
}

/** The general options, validated (unknown keys ignored, missing ones unchanged). */
export function parseGeneral(raw: Record<string, unknown>, prev: GeneralSettings): GeneralSettings {
	const out: GeneralSettings = structuredClone({
		publicUrl: prev.publicUrl,
		mediaLinks: prev.mediaLinks,
		dedupeMinutes: prev.dedupeMinutes,
		ratePer10Min: prev.ratePer10Min,
		progressPercents: prev.progressPercents,
		progressMinutesLeft: prev.progressMinutesLeft,
		hot: prev.hot,
		offlineGraceS: prev.offlineGraceS
	});
	if ('publicUrl' in raw) {
		const u = typeof raw.publicUrl === 'string' ? raw.publicUrl.trim().replace(/\/+$/, '') : '';
		if (u && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(u)) throw new SettingsError('The public URL must be http(s)://…');
		out.publicUrl = u || null;
	}
	if ('mediaLinks' in raw) out.mediaLinks = raw.mediaLinks === true;
	if ('dedupeMinutes' in raw) out.dedupeMinutes = num(raw.dedupeMinutes, 0, 1440, prev.dedupeMinutes);
	if ('ratePer10Min' in raw) out.ratePer10Min = Math.round(num(raw.ratePer10Min, 1, 1000, prev.ratePer10Min));
	if ('progressPercents' in raw) out.progressPercents = numList(raw.progressPercents, 1, 99, 'Progress percentages');
	if ('progressMinutesLeft' in raw) out.progressMinutesLeft = numList(raw.progressMinutesLeft, 1, 1440, 'Minutes left');
	if (raw.hot && typeof raw.hot === 'object') {
		const h = raw.hot as Record<string, unknown>;
		out.hot = { minutes: num(h.minutes, 0.1, 240, prev.hot.minutes), bedC: num(h.bedC, 20, 150, prev.hot.bedC), hotendC: num(h.hotendC, 20, 400, prev.hot.hotendC) };
	}
	if ('offlineGraceS' in raw) out.offlineGraceS = Math.round(num(raw.offlineGraceS, 0, 3600, prev.offlineGraceS));
	return out;
}

/** Saves the general options and/or the rules. */
export function saveSettings(raw: Record<string, unknown>): Stored {
	const s = load();
	const general = parseGeneral(raw, s);
	const rules = 'rules' in raw ? parseRules(raw.rules, new Set(s.channels.map((c) => c.id))) : s.rules;
	const next: Stored = { ...s, ...general, rules };
	save(next);
	return next;
}

export function generalOf(s: Stored): GeneralSettings {
	const { publicUrl, mediaLinks, dedupeMinutes, ratePer10Min, progressPercents, progressMinutesLeft, hot, offlineGraceS } = s;
	return { publicUrl, mediaLinks, dedupeMinutes, ratePer10Min, progressPercents, progressMinutesLeft, hot, offlineGraceS };
}

/** Records the outcome of a delivery on the channel. */
export function recordResult(id: string, error: string | null) {
	const s = load();
	const c = s.channels.find((x) => x.id === id);
	if (!c) return;
	c.lastError = error;
	if (!error) c.lastSentAt = new Date().toISOString();
	save(s);
}

/** The address used in links: the setting, else ORIGIN. */
export function publicUrlOf(s: Pick<GeneralSettings, 'publicUrl'>): string | null {
	return s.publicUrl || process.env.ORIGIN?.replace(/\/+$/, '') || null;
}

// --- backup ------------------------------------------------------------------

/** Settings with every channel's secrets in the clear, for an encrypted backup. */
export interface PortableSettings extends Omit<Stored, 'channels'> {
	channels: (Omit<StoredChannel, 'sealed'> & { secrets: Record<string, string> })[];
}

export function exportSettings(): PortableSettings {
	const s = load();
	return { ...s, channels: s.channels.map(({ sealed: _sealed, ...c }) => ({ ...c, secrets: secretsOf({ id: c.id, sealed: _sealed }) })) };
}

/** Validates a backup's notification settings (throws a SettingsError). */
export function checkPortable(raw: unknown): PortableSettings {
	const p = raw as PortableSettings;
	if (!p || typeof p !== 'object' || !Array.isArray(p.channels) || !Array.isArray(p.rules)) throw new SettingsError('notification settings');
	for (const c of p.channels) {
		if (!c || typeof c.id !== 'string' || !isChannelType(c.type) || typeof c.name !== 'string') throw new SettingsError('a notification channel');
		if (c.secrets && typeof c.secrets !== 'object') throw new SettingsError(`secrets of ${c.name}`);
	}
	return p;
}

/** Replaces the settings with a backup's, sealing the secrets with this install's key. */
export function importSettings(p: PortableSettings) {
	const base = fresh();
	const general = parseGeneral(p as unknown as Record<string, unknown>, base);
	const channels: StoredChannel[] = p.channels.map((c) => ({
		id: c.id,
		type: c.type,
		name: c.name,
		enabled: c.enabled !== false,
		config: Object.fromEntries(Object.entries(c.config ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
		sealed: seal(c.id, Object.fromEntries(Object.entries(c.secrets ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>),
		quiet: parseQuiet(c.quiet),
		lastError: null,
		lastSentAt: c.lastSentAt ?? null
	}));
	const rules = parseRules(p.rules, new Set(channels.map((c) => c.id)));
	save({ ...base, ...general, channels, rules });
	deleteKv(LEGACY_KEY);
}
