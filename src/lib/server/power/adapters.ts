/**
 * Smart plug adapters: one small class per device API, all behind `PlugAdapter`.
 *
 * - Shelly Gen1: `/relay/<n>?turn=on|off`, status and meter from `/status` (Basic auth).
 * - Shelly Gen2+ (Plus, Pro, Gen3/4): RPC `Switch.Set` / `Switch.GetStatus` (Digest auth, user `admin`).
 *   The generation is detected from `/shelly` unless set.
 * - Tasmota: `/cm?cmnd=Power<n> On`, energy from `Status 8` (optional `user`/`password` parameters).
 * - Home Assistant: a switch/light/input_boolean entity over the REST API with a long-lived token,
 *   optional power (W) and energy (kWh) sensor entities.
 * - HTTP: configurable on/off/status requests; the status body is matched against an expected text.
 */
import { plugFetch, PlugError, type HttpDeps, type PlugRequest } from './http.ts';
import type { PlugKind, PlugReading } from '#lib/power.ts';

export { PlugError };

export interface PlugAdapter {
	readonly kind: PlugKind;
	status(): Promise<PlugReading>;
	set(on: boolean): Promise<void>;
}

export type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
};
const trimSlash = (s: string) => s.replace(/\/+$/, '');
const EMPTY: PlugReading = { on: null, powerW: null, energyWh: null, voltageV: null };

// --- configs (validated in config.ts) ---------------------------------------------------

export interface ShellyConfig {
	url: string;
	channel: number;
	generation: 'auto' | '1' | '2';
}
export interface TasmotaConfig {
	url: string;
	/** 0: the device's only relay (`Power`); 1–8: `Power<n>`. */
	channel: number;
}
export interface HomeAssistantConfig {
	url: string;
	entityId: string;
	powerEntityId: string;
	energyEntityId: string;
}
export interface HttpConfig {
	onUrl: string;
	onMethod: string;
	onBody: string;
	offUrl: string;
	offMethod: string;
	offBody: string;
	contentType: string;
	statusUrl: string;
	statusMethod: string;
	/** Status body containing this (or matching `/regex/flags`) means on. */
	onPattern: string;
	/** …and this means off; without it, anything but `onPattern` is off. */
	offPattern: string;
}
export interface PlugSecrets {
	username?: string;
	password?: string;
	token?: string;
	authorization?: string;
}

// --- Shelly -------------------------------------------------------------------------

export class ShellyAdapter implements PlugAdapter {
	readonly kind = 'shelly' as const;
	private gen: 1 | 2 | null;
	private cfg: ShellyConfig;
	private secrets: PlugSecrets;
	private deps: HttpDeps;

	constructor(cfg: ShellyConfig, secrets: PlugSecrets, deps: HttpDeps = {}) {
		this.cfg = cfg;
		this.secrets = secrets;
		this.deps = deps;
		this.gen = cfg.generation === '1' ? 1 : cfg.generation === '2' ? 2 : null;
	}

	private auth(gen: 1 | 2): PlugRequest['auth'] {
		if (!this.secrets.password) return undefined;
		return gen === 2
			? { username: this.secrets.username || 'admin', password: this.secrets.password, scheme: 'digest' }
			: { username: this.secrets.username || 'admin', password: this.secrets.password, scheme: 'basic' };
	}

	private get(path: string, gen: 1 | 2) {
		return plugFetch(`${trimSlash(this.cfg.url)}${path}`, { auth: this.auth(gen) }, this.deps);
	}

	/** Gen1 answers /shelly with `type`; Gen2+ with `gen: 2|3|4`. /shelly needs no login on either. */
	async generation(): Promise<1 | 2> {
		if (this.gen) return this.gen;
		const info = (await plugFetch(`${trimSlash(this.cfg.url)}/shelly`, {}, this.deps)).json<Obj>();
		this.gen = num(info?.gen) != null && num(info.gen)! >= 2 ? 2 : 1;
		return this.gen;
	}

	async status(): Promise<PlugReading> {
		const gen = await this.generation();
		const ch = this.cfg.channel;
		if (gen === 2) {
			const s = (await this.get(`/rpc/Switch.GetStatus?id=${ch}`, 2)).json<Obj>();
			if (!isObj(s) || typeof s.output !== 'boolean') throw new PlugError(`The Shelly has no switch ${ch}`, { code: 'BAD_RESPONSE' });
			const energy = isObj(s.aenergy) ? num(s.aenergy.total) : null;
			return { on: s.output, powerW: num(s.apower), energyWh: energy, voltageV: num(s.voltage) };
		}
		const s = (await this.get('/status', 1)).json<Obj>();
		const relay = Array.isArray(s?.relays) ? s.relays[ch] : null;
		if (!isObj(relay) || typeof relay.ison !== 'boolean') throw new PlugError(`The Shelly has no relay ${ch}`, { code: 'BAD_RESPONSE' });
		// Plug S / 1PM: meters[n]; EM-style devices: emeters[n]. Gen1 `total` is in watt-minutes.
		const meters = Array.isArray(s.meters) ? s.meters : Array.isArray(s.emeters) ? s.emeters : [];
		const m = isObj(meters[ch]) ? (meters[ch] as Obj) : null;
		const total = m ? num(m.total) : null;
		return {
			on: relay.ison,
			powerW: m ? num(m.power) : null,
			energyWh: total == null ? null : Array.isArray(s.emeters) ? total : Math.round((total / 60) * 100) / 100,
			voltageV: m ? num(m.voltage) : null
		};
	}

	async set(on: boolean): Promise<void> {
		const gen = await this.generation();
		if (gen === 2) await this.get(`/rpc/Switch.Set?id=${this.cfg.channel}&on=${on}`, 2);
		else await this.get(`/relay/${this.cfg.channel}?turn=${on ? 'on' : 'off'}`, 1);
	}
}

// --- Tasmota ------------------------------------------------------------------------

export class TasmotaAdapter implements PlugAdapter {
	readonly kind = 'tasmota' as const;
	private cfg: TasmotaConfig;
	private secrets: PlugSecrets;
	private deps: HttpDeps;

	constructor(cfg: TasmotaConfig, secrets: PlugSecrets, deps: HttpDeps = {}) {
		this.cfg = cfg;
		this.secrets = secrets;
		this.deps = deps;
	}

	private async cmnd(command: string): Promise<Obj> {
		const q = new URLSearchParams();
		if (this.secrets.password) {
			q.set('user', this.secrets.username || 'admin');
			q.set('password', this.secrets.password);
		}
		q.set('cmnd', command);
		const r = (await plugFetch(`${trimSlash(this.cfg.url)}/cm?${q.toString().replace(/\+/g, '%20')}`, {}, this.deps)).json<Obj>();
		if (isObj(r) && typeof r.WARNING === 'string' && /user=|password/i.test(r.WARNING)) {
			throw new PlugError('Tasmota asks for a login', { code: 'AUTH', hint: 'Add the web admin username and password.' });
		}
		if (isObj(r) && r.Command === 'Unknown') throw new PlugError(`Tasmota doesn’t know “${command}”`, { code: 'BAD_RESPONSE' });
		return r;
	}

	private get power() {
		return this.cfg.channel > 0 ? `Power${this.cfg.channel}` : 'Power';
	}

	private parse(r: Obj): boolean {
		const keys = this.cfg.channel > 0 ? [`POWER${this.cfg.channel}`, ...(this.cfg.channel === 1 ? ['POWER'] : [])] : ['POWER', 'POWER1'];
		for (const k of keys) {
			const v = r?.[k];
			if (typeof v === 'string') return v.toUpperCase() === 'ON';
		}
		throw new PlugError(`Tasmota didn’t report ${this.power}`, { code: 'BAD_RESPONSE', hint: 'Check the relay number.' });
	}

	async status(): Promise<PlugReading> {
		const [p, e] = await Promise.all([this.cmnd(this.power), this.cmnd('Status 8').catch(() => null)]);
		const reading: PlugReading = { ...EMPTY, on: this.parse(p) };
		const energy = e && isObj(e.StatusSNS) && isObj(e.StatusSNS.ENERGY) ? e.StatusSNS.ENERGY : null;
		if (energy) {
			const pick = (v: unknown) => (Array.isArray(v) ? num(v[Math.max(0, this.cfg.channel - 1)]) : num(v));
			reading.powerW = pick(energy.Power);
			const kwh = pick(energy.Total);
			reading.energyWh = kwh == null ? null : Math.round(kwh * 1000 * 100) / 100;
			reading.voltageV = pick(energy.Voltage);
		}
		return reading;
	}

	async set(on: boolean): Promise<void> {
		const r = await this.cmnd(`${this.power} ${on ? 'On' : 'Off'}`);
		if (this.parse(r) !== on) throw new PlugError(`Tasmota stayed ${on ? 'off' : 'on'}`, { code: 'NOT_SWITCHED' });
	}
}

// --- Home Assistant ------------------------------------------------------------------

export const HA_DOMAINS = ['switch', 'light', 'input_boolean'];

export class HomeAssistantAdapter implements PlugAdapter {
	readonly kind = 'homeassistant' as const;
	private cfg: HomeAssistantConfig;
	private secrets: PlugSecrets;
	private deps: HttpDeps;

	constructor(cfg: HomeAssistantConfig, secrets: PlugSecrets, deps: HttpDeps = {}) {
		this.cfg = cfg;
		this.secrets = secrets;
		this.deps = deps;
	}

	private req(method: string, path: string, body?: unknown) {
		if (!this.secrets.token) throw new PlugError('No Home Assistant token saved', { code: 'AUTH', hint: 'Create a long-lived access token in your Home Assistant profile.' });
		return plugFetch(
			`${trimSlash(this.cfg.url)}${path}`,
			{ method, headers: { authorization: `Bearer ${this.secrets.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
			this.deps
		);
	}

	private async state(entity: string): Promise<Obj> {
		try {
			return (await this.req('GET', `/api/states/${encodeURIComponent(entity)}`)).json<Obj>();
		} catch (err) {
			if (err instanceof PlugError && err.status === 404) throw new PlugError(`Home Assistant has no entity ${entity}`, { code: 'NOT_FOUND' });
			throw err;
		}
	}

	private async sensor(entity: string, units: Record<string, number>): Promise<number | null> {
		if (!entity) return null;
		try {
			const s = await this.state(entity);
			const v = num(s.state);
			if (v == null) return null;
			const unit = isObj(s.attributes) && typeof s.attributes.unit_of_measurement === 'string' ? s.attributes.unit_of_measurement : '';
			return v * (units[unit] ?? 1);
		} catch {
			return null;
		}
	}

	async status(): Promise<PlugReading> {
		const [s, powerW, energyWh] = await Promise.all([
			this.state(this.cfg.entityId),
			this.sensor(this.cfg.powerEntityId, { W: 1, kW: 1000, mW: 0.001 }),
			this.sensor(this.cfg.energyEntityId, { Wh: 1, kWh: 1000, MWh: 1_000_000 })
		]);
		const st = typeof s.state === 'string' ? s.state : '';
		return { on: st === 'on' ? true : st === 'off' ? false : null, powerW, energyWh, voltageV: null };
	}

	async set(on: boolean): Promise<void> {
		const domain = this.cfg.entityId.split('.')[0];
		await this.req('POST', `/api/services/${domain}/turn_${on ? 'on' : 'off'}`, { entity_id: this.cfg.entityId });
	}
}

// --- generic HTTP --------------------------------------------------------------------

/** `/on/i` as a regex, anything else as a case-insensitive substring. */
export function matches(body: string, pattern: string): boolean {
	const re = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
	if (re) {
		try {
			return new RegExp(re[1], re[2].replace('g', '')).test(body);
		} catch {
			return false;
		}
	}
	return body.toLowerCase().includes(pattern.toLowerCase());
}

export class HttpAdapter implements PlugAdapter {
	readonly kind = 'http' as const;
	private cfg: HttpConfig;
	private secrets: PlugSecrets;
	private deps: HttpDeps;

	constructor(cfg: HttpConfig, secrets: PlugSecrets, deps: HttpDeps = {}) {
		this.cfg = cfg;
		this.secrets = secrets;
		this.deps = deps;
	}

	private request(url: string, method: string, body: string) {
		const headers: Record<string, string> = {};
		if (this.secrets.authorization) headers.authorization = this.secrets.authorization;
		const hasBody = !!body && method !== 'GET' && method !== 'HEAD';
		if (hasBody) headers['content-type'] = this.cfg.contentType || 'application/json';
		const auth = this.secrets.username && !this.secrets.authorization ? { username: this.secrets.username, password: this.secrets.password ?? '' } : undefined;
		return plugFetch(url, { method, headers, body: hasBody ? body : undefined, auth }, this.deps);
	}

	async status(): Promise<PlugReading> {
		if (!this.cfg.statusUrl) return { ...EMPTY };
		const r = await this.request(this.cfg.statusUrl, this.cfg.statusMethod || 'GET', '');
		let on: boolean | null;
		if (matches(r.text, this.cfg.onPattern)) on = true;
		else if (this.cfg.offPattern) on = matches(r.text, this.cfg.offPattern) ? false : null;
		else on = false;
		return { ...EMPTY, on };
	}

	async set(on: boolean): Promise<void> {
		await this.request(on ? this.cfg.onUrl : this.cfg.offUrl, (on ? this.cfg.onMethod : this.cfg.offMethod) || 'POST', on ? this.cfg.onBody : this.cfg.offBody);
	}

	/** Without a status URL the plug can't say whether it's on. */
	get canRead() {
		return !!this.cfg.statusUrl;
	}
}

export function createAdapter(kind: PlugKind, config: Record<string, unknown>, secrets: PlugSecrets, deps: HttpDeps = {}): PlugAdapter {
	switch (kind) {
		case 'shelly':
			return new ShellyAdapter(config as unknown as ShellyConfig, secrets, deps);
		case 'tasmota':
			return new TasmotaAdapter(config as unknown as TasmotaConfig, secrets, deps);
		case 'homeassistant':
			return new HomeAssistantAdapter(config as unknown as HomeAssistantConfig, secrets, deps);
		case 'http':
			return new HttpAdapter(config as unknown as HttpConfig, secrets, deps);
	}
}
