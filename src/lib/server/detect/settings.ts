/**
 * Failure detection settings: the ML API (admins) and per-printer options (operators).
 * The ML API token is sealed with the master key and never sent to the browser.
 * Environment variables (OCM_ML_API_URL, OCM_ML_API_TOKEN, OCM_DETECT_PUBLIC_URL)
 * are defaults that saved settings override.
 */
import { decrypt, encrypt } from '../crypto.ts';
import { deleteKv, getKv, setKv } from '../store.ts';
import { DETECT_DEFAULTS, INTERVAL, SENSITIVITY, SKIP_MINUTES, type DetectGlobalInfo, type FailureAction, type PrinterDetectSettings } from '#lib/detect.ts';
import type { MlApiConfig } from './obico.ts';
import type { Baseline } from './score.ts';

const GLOBAL_KEY = 'detect:settings';
const printerKey = (id: string) => `detect:printer:${id}`;
const baselineKey = (id: string) => `detect:baseline:${id}`;

interface StoredGlobal {
	mlApiUrl: string | null;
	sealedToken: string | null;
	publicUrl: string | null;
}

const env = (name: string) => process.env[name]?.trim() || null;
const loadGlobal = (): StoredGlobal => getKv<StoredGlobal>(GLOBAL_KEY, { mlApiUrl: null, sealedToken: null, publicUrl: null });

export function globalInfo(): DetectGlobalInfo {
	const s = loadGlobal();
	return {
		mlApiUrl: s.mlApiUrl ?? env('OCM_ML_API_URL'),
		hasToken: !!s.sealedToken || !!env('OCM_ML_API_TOKEN'),
		publicUrl: s.publicUrl ?? env('OCM_DETECT_PUBLIC_URL'),
		fromEnv: { mlApiUrl: !s.mlApiUrl && !!env('OCM_ML_API_URL'), token: !s.sealedToken && !!env('OCM_ML_API_TOKEN'), publicUrl: !s.publicUrl && !!env('OCM_DETECT_PUBLIC_URL') }
	};
}

/** Server-only: the ML API and the address it reaches octo·modern at, when both are set. */
export function mlConfig(): (MlApiConfig & { publicUrl: string }) | null {
	const s = loadGlobal();
	const url = s.mlApiUrl ?? env('OCM_ML_API_URL');
	const publicUrl = s.publicUrl ?? env('OCM_DETECT_PUBLIC_URL');
	if (!url || !publicUrl) return null;
	const token = s.sealedToken ? decrypt(s.sealedToken, 'detect:ml-api') : env('OCM_ML_API_TOKEN');
	return { url, token, publicUrl };
}

export function httpUrl(raw: unknown, label: string): string | null {
	if (raw === null || raw === undefined || raw === '') return null;
	if (typeof raw !== 'string') throw new Error(`${label} must be a URL`);
	const s = raw.trim().replace(/\/+$/, '');
	if (!s) return null;
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		throw new Error(`${label} must be an http(s) URL`);
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${label} must be an http(s) URL`);
	if (u.username || u.password) throw new Error(`${label} must not contain credentials`);
	if (u.search || u.hash) throw new Error(`${label} must not have a query or fragment`);
	return s;
}

/**
 * Saves the admin settings. `token`: a string replaces it, `null` or `''` clears it,
 * undefined keeps it. Throws with a message for the user on invalid input.
 */
export function saveGlobal(input: { mlApiUrl?: unknown; token?: unknown; publicUrl?: unknown }): DetectGlobalInfo {
	const prev = loadGlobal();
	const next: StoredGlobal = { ...prev };
	if (input.mlApiUrl !== undefined) next.mlApiUrl = httpUrl(input.mlApiUrl, 'The ML API URL');
	if (input.publicUrl !== undefined) next.publicUrl = httpUrl(input.publicUrl, 'octo·modern’s address');
	if (input.token !== undefined) {
		if (input.token === null || input.token === '') next.sealedToken = null;
		else if (typeof input.token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(input.token.trim())) throw new Error('The token has unexpected characters');
		else next.sealedToken = encrypt(input.token.trim(), 'detect:ml-api');
	}
	setKv(GLOBAL_KEY, next);
	return globalInfo();
}

// --- per printer ---------------------------------------------------------------------

export function printerSettings(id: string): PrinterDetectSettings {
	return { ...DETECT_DEFAULTS, ...getKv<Partial<PrinterDetectSettings>>(printerKey(id), {}) };
}

const ACTIONS: FailureAction[] = ['none', 'notify', 'pause'];

function num(v: unknown, label: string, r: { min: number; max: number }): number {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
	if (!Number.isFinite(n) || n < r.min || n > r.max) throw new Error(`${label} must be from ${r.min} to ${r.max}`);
	return n;
}

/** Merges a patch into a printer's settings; throws on invalid input. */
export function parsePrinterSettings(prev: PrinterDetectSettings, b: Record<string, unknown>): PrinterDetectSettings {
	const out = { ...prev };
	if (b.enabled !== undefined) {
		if (typeof b.enabled !== 'boolean') throw new Error('"enabled" must be true or false');
		out.enabled = b.enabled;
	}
	if (b.sensitivity !== undefined) out.sensitivity = Math.round(num(b.sensitivity, 'Sensitivity', SENSITIVITY) * 100) / 100;
	if (b.intervalS !== undefined) out.intervalS = Math.round(num(b.intervalS, 'The interval', { min: minInterval(), max: INTERVAL.max }));
	if (b.skipMinutes !== undefined) out.skipMinutes = Math.round(num(b.skipMinutes, 'Skipped minutes', SKIP_MINUTES));
	if (b.onFailure !== undefined) {
		if (!ACTIONS.includes(b.onFailure as FailureAction)) throw new Error('"onFailure" must be none, notify or pause');
		out.onFailure = b.onFailure as FailureAction;
	}
	return out;
}

/** Shortest interval; OCM_DETECT_MIN_INTERVAL_S lowers it for tests. */
export function minInterval(): number {
	const n = Number(process.env.OCM_DETECT_MIN_INTERVAL_S);
	return Number.isFinite(n) && n >= 1 ? Math.min(n, INTERVAL.min) : INTERVAL.min;
}

export function savePrinterSettings(id: string, s: PrinterDetectSettings) {
	setKv(printerKey(id), s);
}

export function loadBaseline(id: string): Baseline {
	return getKv<Baseline>(baselineKey(id), { frames: 0, long: 0 });
}

export function saveBaseline(id: string, b: Baseline) {
	setKv(baselineKey(id), b);
}

export function forgetPrinter(id: string) {
	deleteKv(printerKey(id));
	deleteKv(baselineKey(id));
}
