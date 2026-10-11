/**
 * "Test connection" for Klipper printers, and auto-detection of what answers at a URL.
 *
 * Moonraker is probed first: it emulates parts of OctoPrint's API (`[octoprint_compat]`,
 * for slicer uploads), so `/api/version` alone can't tell them apart. `/server/info`
 * is Moonraker's own and answers even without a key on trusted networks (401 with
 * Moonraker's JSON error otherwise).
 */
import { httpFetch } from '../octoprint/transport.ts';
import { OctoPrintError, toOctoPrintError } from '../octoprint/errors.ts';
import { MoonrakerClient, type MoonrakerTarget } from './client.ts';
import { versionText } from './parse.ts';
import type { PrinterKind, TestResult } from '#lib/types.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export interface ProbeResponse {
	status: number;
	body: string;
}

function parse(body: string | undefined): Obj | null {
	try {
		const j = JSON.parse(body ?? '');
		return isObj(j) ? j : null;
	} catch {
		return null;
	}
}

/** Pure: which server the two probe answers point to (null: neither). */
export function analyzeKind(r: { serverInfo: ProbeResponse | null; apiVersion: ProbeResponse | null }): { kind: PrinterKind | null; signals: string[] } {
	const signals: string[] = [];
	const si = r.serverInfo;
	if (si) {
		const j = parse(si.body);
		const result = isObj(j?.result) ? j.result : null;
		if (si.status === 200 && result && ('klippy_state' in result || 'moonraker_version' in result || 'klippy_connected' in result)) {
			signals.push(`GET /server/info → Moonraker${typeof result.moonraker_version === 'string' ? ` ${result.moonraker_version}` : ''}`);
			return { kind: 'moonraker', signals };
		}
		if ((si.status === 401 || si.status === 403) && j && isObj(j.error) && typeof j.error.code === 'number') {
			signals.push(`GET /server/info → ${si.status} (Moonraker wants a key)`);
			return { kind: 'moonraker', signals };
		}
	}
	const av = r.apiVersion;
	if (av) {
		const j = parse(av.body);
		if (av.status === 200 && j && typeof j.server === 'string' && (typeof j.api === 'string' || /octoprint/i.test(String(j.text ?? '')))) {
			signals.push(`GET /api/version → ${String(j.text ?? `OctoPrint ${j.server}`)}`);
			return { kind: 'octoprint', signals };
		}
		if ((av.status === 401 || av.status === 403) && j && typeof j.error === 'string') {
			signals.push(`GET /api/version → ${av.status} (OctoPrint wants a key)`);
			return { kind: 'octoprint', signals };
		}
	}
	return { kind: null, signals };
}

async function get(url: string, apiKey: string, verifyTls: boolean, timeoutMs: number): Promise<ProbeResponse | null> {
	try {
		const res = await httpFetch(url, { method: 'GET', headers: { accept: 'application/json', ...(apiKey ? { 'X-Api-Key': apiKey } : {}) }, signal: AbortSignal.timeout(timeoutMs) }, verifyTls);
		const body = (await res.text()).slice(0, 64_000);
		return { status: res.status, body };
	} catch {
		return null;
	}
}

/** Looks at `baseUrl` and says whether OctoPrint or Moonraker answers there. */
export async function detectKind(target: { baseUrl: string; apiKey: string; verifyTls: boolean }, timeoutMs = 6_000): Promise<{ kind: PrinterKind | null; signals: string[] }> {
	const base = target.baseUrl.replace(/\/+$/, '');
	const [serverInfo, apiVersion] = await Promise.all([get(`${base}/server/info`, target.apiKey, target.verifyTls, timeoutMs), get(`${base}/api/version`, target.apiKey, target.verifyTls, timeoutMs)]);
	return analyzeKind({ serverInfo, apiVersion });
}

const KLIPPY_NOTE: Record<string, string> = {
	startup: 'Klipper is starting up.',
	shutdown: 'Klipper is shut down; a firmware restart brings it back.',
	error: 'Klipper reports an error; a firmware restart usually helps.',
	disconnected: 'Moonraker isn’t connected to Klipper (is the klipper service running?).'
};

/** Reaches Moonraker, checks the key (if any), and reports the Klipper and Moonraker versions. */
export async function testMoonraker(target: MoonrakerTarget, timeoutMs = 8_000): Promise<TestResult> {
	const client = new MoonrakerClient(target, timeoutMs);
	const started = performance.now();
	try {
		const info = await client.serverInfo();
		const latencyMs = Math.round(performance.now() - started);
		if (!isObj(info) || !('klippy_state' in info || 'moonraker_version' in info)) {
			throw new OctoPrintError('That doesn’t look like Moonraker', {
				code: 'NOT_MOONRAKER',
				hint: 'GET /server/info didn’t answer like Moonraker. Use Moonraker’s address (usually port 7125), or the Mainsail/Fluidd host that proxies it.'
			});
		}
		const state = typeof info.klippy_state === 'string' ? info.klippy_state : 'ready';
		const pinfo = state === 'disconnected' ? {} : ((await client.printerInfo().catch(() => ({}))) ?? {});
		const notes: string[] = [];
		const pstate = typeof pinfo.state === 'string' ? pinfo.state : state;
		if (pstate !== 'ready') notes.push(`${KLIPPY_NOTE[pstate] ?? `Klipper is ${pstate}.`}${typeof pinfo.state_message === 'string' && pinfo.state_message ? ` (${pinfo.state_message.split('\n')[0]})` : ''}`);
		if (!target.apiKey) notes.push('No API key: Moonraker trusts octo·modern’s address (trusted_clients).');
		return {
			ok: true,
			kind: 'moonraker',
			version: versionText(pinfo.software_version, info.moonraker_version) ?? 'Moonraker',
			apiVersion: typeof info.api_version_string === 'string' ? info.api_version_string : null,
			user: null,
			permissions: [],
			missing: [],
			latencyMs,
			notes
		};
	} catch (err) {
		return { ok: false, error: toOctoPrintError(err, client.host).toJSON() };
	}
}
