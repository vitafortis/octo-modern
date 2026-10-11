/**
 * Plug configuration: validation of what an admin enters, and storage. One plug per
 * printer (table `power_plugs`); credentials are sealed with AES-256-GCM, bound to the
 * printer id, and only hinted at to the browser.
 */
import { decrypt, encrypt } from '../crypto.ts';
import { sqlite } from '../store.ts';
import { HA_DOMAINS, type HomeAssistantConfig, type HttpConfig, type PlugSecrets, type ShellyConfig, type TasmotaConfig } from './adapters.ts';
import { DEFAULT_POWER_SETTINGS, PLUG_KINDS, type PlugConfigView, type PlugKind, type PowerSettings } from '#lib/power.ts';

export class PlugConfigError extends Error {}

export interface StoredPlug {
	printerId: string;
	kind: PlugKind;
	label: string | null;
	config: Record<string, string | number | boolean>;
	secrets: PlugSecrets;
	settings: PowerSettings;
	updatedAt: string;
}

const SECRET_FIELDS: Record<PlugKind, (keyof PlugSecrets)[]> = {
	shelly: ['username', 'password'],
	tasmota: ['username', 'password'],
	homeassistant: ['token'],
	http: ['username', 'password', 'authorization']
};
/** Not secret, but kept with the secrets (shown back in full to admins). */
const PLAIN_SECRETS = new Set<keyof PlugSecrets>(['username']);

type Obj = Record<string, unknown>;
const str = (o: Obj, k: string, max = 500) => (typeof o[k] === 'string' ? (o[k] as string).trim().slice(0, max) : '');

/** `192.168.1.40` → `http://192.168.1.40`; refuses credentials in the URL (they go in the sealed fields). */
export function deviceUrl(raw: string, label: string, { path = false } = {}): string {
	let s = raw.trim();
	if (!s) throw new PlugConfigError(`${label} is required`);
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		throw new PlugConfigError(`${label} isn’t a valid address`);
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PlugConfigError(`${label} must be http:// or https://`);
	if (u.username || u.password) throw new PlugConfigError(`Put the login in the username and password fields, not in ${label.toLowerCase()}`);
	if (!path) return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
	return u.toString();
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH'];
const method = (o: Obj, k: string, fallback: string) => {
	const m = str(o, k, 10).toUpperCase() || fallback;
	if (!METHODS.includes(m)) throw new PlugConfigError(`Method must be one of ${METHODS.join(', ')}`);
	return m;
};
const int = (v: unknown, label: string, min: number, max: number, fallback: number) => {
	if (v === undefined || v === null || v === '') return fallback;
	const n = Number(v);
	if (!Number.isInteger(n) || n < min || n > max) throw new PlugConfigError(`${label} must be a whole number from ${min} to ${max}`);
	return n;
};

export function parseSettings(raw: unknown): PowerSettings {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Obj;
	const d = DEFAULT_POWER_SETTINGS;
	const ao = (o.autoOff && typeof o.autoOff === 'object' ? o.autoOff : {}) as Obj;
	return {
		autoConnect: o.autoConnect === undefined ? d.autoConnect : o.autoConnect === true,
		autoOn: o.autoOn === true,
		autoOff: {
			enabled: ao.enabled === true,
			hotendC: int(ao.hotendC, 'Cool-down temperature', 20, 150, d.autoOff.hotendC),
			idleMinutes: int(ao.idleMinutes, 'Idle minutes', 0, 1440, d.autoOff.idleMinutes)
		},
		hotHotendC: int(o.hotHotendC, 'Hot hotend temperature', 20, 300, d.hotHotendC),
		hotBedC: int(o.hotBedC, 'Hot bed temperature', 20, 150, d.hotBedC)
	};
}

/**
 * Validates a plug form. Secret fields left empty keep `previous` (same kind only), so
 * the browser never needs them back; `clearSecrets` lists fields to remove.
 */
export function parsePlugInput(raw: unknown, previous?: Pick<StoredPlug, 'kind' | 'secrets'>): Omit<StoredPlug, 'printerId' | 'updatedAt'> {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Obj;
	const kind = o.kind as PlugKind;
	if (!PLUG_KINDS.includes(kind)) throw new PlugConfigError(`"kind" must be one of ${PLUG_KINDS.join(', ')}`);
	const c = (o.config && typeof o.config === 'object' ? o.config : {}) as Obj;
	let config: Record<string, string | number | boolean>;
	switch (kind) {
		case 'shelly': {
			const generation = str(c, 'generation', 4) || 'auto';
			if (!['auto', '1', '2'].includes(generation)) throw new PlugConfigError('Generation must be auto, 1 or 2');
			config = { url: deviceUrl(str(c, 'url'), 'The address'), channel: int(c.channel, 'Channel', 0, 7, 0), generation: generation as ShellyConfig['generation'] } satisfies ShellyConfig;
			break;
		}
		case 'tasmota':
			config = { url: deviceUrl(str(c, 'url'), 'The address'), channel: int(c.channel, 'Relay', 0, 8, 0) } satisfies TasmotaConfig;
			break;
		case 'homeassistant': {
			const entityId = str(c, 'entityId', 255);
			const domain = entityId.split('.')[0];
			if (!/^[a-z_]+\.[a-z0-9_]+$/.test(entityId) || !HA_DOMAINS.includes(domain)) {
				throw new PlugConfigError(`The entity must look like switch.printer_plug (${HA_DOMAINS.join(', ')})`);
			}
			const sensor = (k: string, label: string) => {
				const v = str(c, k, 255);
				if (v && !/^sensor\.[a-z0-9_]+$/.test(v)) throw new PlugConfigError(`${label} must look like sensor.printer_power`);
				return v;
			};
			config = { url: deviceUrl(str(c, 'url'), 'The Home Assistant URL'), entityId, powerEntityId: sensor('powerEntityId', 'The power sensor'), energyEntityId: sensor('energyEntityId', 'The energy sensor') } satisfies HomeAssistantConfig;
			break;
		}
		case 'http': {
			const statusUrl = str(c, 'statusUrl', 2000) ? deviceUrl(str(c, 'statusUrl', 2000), 'The status URL', { path: true }) : '';
			const onPattern = str(c, 'onPattern', 200);
			if (statusUrl && !onPattern) throw new PlugConfigError('With a status URL, say what the answer contains when the plug is on');
			config = {
				onUrl: deviceUrl(str(c, 'onUrl', 2000), 'The “on” URL', { path: true }),
				onMethod: method(c, 'onMethod', 'POST'),
				onBody: str(c, 'onBody', 2000),
				offUrl: deviceUrl(str(c, 'offUrl', 2000), 'The “off” URL', { path: true }),
				offMethod: method(c, 'offMethod', 'POST'),
				offBody: str(c, 'offBody', 2000),
				contentType: str(c, 'contentType', 100) || 'application/json',
				statusUrl,
				statusMethod: method(c, 'statusMethod', 'GET'),
				onPattern,
				offPattern: str(c, 'offPattern', 200)
			} satisfies HttpConfig;
			break;
		}
	}
	const s = (o.secrets && typeof o.secrets === 'object' ? o.secrets : {}) as Obj;
	const clear = new Set(Array.isArray(o.clearSecrets) ? (o.clearSecrets as unknown[]).filter((x): x is string => typeof x === 'string') : []);
	const prev = previous && previous.kind === kind ? previous.secrets : {};
	const secrets: PlugSecrets = {};
	for (const f of SECRET_FIELDS[kind]) {
		const v = typeof s[f] === 'string' ? (s[f] as string).trim().slice(0, 4000) : '';
		if (v) secrets[f] = v;
		else if (PLAIN_SECRETS.has(f) && typeof s[f] === 'string') continue; // an emptied username clears it
		else if (!clear.has(f) && prev[f]) secrets[f] = prev[f];
	}
	if (kind === 'homeassistant' && !secrets.token) throw new PlugConfigError('Paste a Home Assistant long-lived access token');
	const label = str(o, 'label', 80) || null;
	return { kind, label, config, secrets, settings: parseSettings(o.settings) };
}

/** Safe-to-show hints for stored secrets: usernames in full, the rest masked. */
export function secretHints(secrets: PlugSecrets): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(secrets)) if (v) out[k] = PLAIN_SECRETS.has(k as keyof PlugSecrets) ? v : '••••••';
	return out;
}

export function configView(p: StoredPlug): PlugConfigView {
	return { kind: p.kind, label: p.label, config: p.config, secrets: secretHints(p.secrets), settings: p.settings, updatedAt: p.updatedAt };
}

/** A short description for the audit log (the host, never credentials). */
export function describePlug(p: Pick<StoredPlug, 'kind' | 'config'>): string {
	const url = (p.config.url ?? p.config.onUrl) as string | undefined;
	let host = '';
	try {
		host = url ? new URL(url).host : '';
	} catch {}
	const extra = p.kind === 'homeassistant' ? ` ${p.config.entityId}` : p.kind === 'shelly' || p.kind === 'tasmota' ? ` #${p.config.channel}` : '';
	return `${p.kind} ${host}${extra}`.trim();
}

// --- storage ------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const context = (printerId: string) => `power:${printerId}`;

function toPlug(r: Row): StoredPlug {
	return {
		printerId: r.printer_id as string,
		kind: r.kind as PlugKind,
		label: (r.label as string) ?? null,
		config: JSON.parse(r.config as string),
		secrets: r.secret ? JSON.parse(decrypt(r.secret as string, context(r.printer_id as string))) : {},
		settings: parseSettings(JSON.parse(r.settings as string)),
		updatedAt: r.updated_at as string
	};
}

export function getPlug(printerId: string): StoredPlug | undefined {
	const r = sqlite().prepare('SELECT * FROM power_plugs WHERE printer_id = ?').get(printerId) as Row | undefined;
	return r && toPlug(r);
}

export function listPlugs(): StoredPlug[] {
	return (sqlite().prepare('SELECT * FROM power_plugs').all() as Row[]).map(toPlug);
}

export function savePlug(printerId: string, p: Omit<StoredPlug, 'printerId' | 'updatedAt'>): StoredPlug {
	const now = new Date().toISOString();
	const sealed = Object.keys(p.secrets).length ? encrypt(JSON.stringify(p.secrets), context(printerId)) : null;
	sqlite()
		.prepare(
			`INSERT INTO power_plugs (printer_id, kind, label, config, secret, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(printer_id) DO UPDATE SET kind = excluded.kind, label = excluded.label, config = excluded.config, secret = excluded.secret, settings = excluded.settings, updated_at = excluded.updated_at`
		)
		.run(printerId, p.kind, p.label, JSON.stringify(p.config), sealed, JSON.stringify(p.settings), now, now);
	return getPlug(printerId)!;
}

export function deletePlug(printerId: string): boolean {
	return Number(sqlite().prepare('DELETE FROM power_plugs WHERE printer_id = ?').run(printerId).changes) > 0;
}
