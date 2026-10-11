/**
 * "Test connection" for either kind, with auto-detection when the admin chose "Auto".
 */
import { testServer } from '../octoprint/probe.ts';
import { detectKind, testMoonraker } from '../moonraker/probe.ts';
import type { PrinterKind, TestResult } from '#lib/types.ts';

export interface TestTarget {
	baseUrl: string;
	apiKey: string;
	verifyTls: boolean;
	kind: PrinterKind | 'auto';
}

export async function testPrinter(t: TestTarget): Promise<TestResult> {
	let kind = t.kind;
	if (kind === 'auto') {
		const found = await detectKind(t);
		if (!found.kind) {
			// Unreachable (refused, timeout, TLS…): that error says more than "unknown server".
			const reach = await testMoonraker({ baseUrl: t.baseUrl, apiKey: t.apiKey, verifyTls: t.verifyTls });
			if (!reach.ok && reach.error.code && !/^(HTTP_|NOT_MOONRAKER|BAD_RESPONSE)/.test(reach.error.code)) return reach;
			return {
				ok: false,
				error: { message: 'Neither OctoPrint nor Moonraker answered at this URL', code: 'UNKNOWN_SERVER', hint: 'Check the address and port: OctoPrint usually serves on 80 or 5000, Moonraker on 7125 (or behind Mainsail/Fluidd on 80).' }
			};
		}
		kind = found.kind;
	}
	if (kind === 'moonraker') return testMoonraker({ baseUrl: t.baseUrl, apiKey: t.apiKey, verifyTls: t.verifyTls });
	if (!t.apiKey) return { ok: false, error: { message: 'Paste an API key to test with', code: 'NO_KEY', hint: 'OctoPrint needs an Application Key or a user API key.' } };
	const r = await testServer({ baseUrl: t.baseUrl, apiKey: t.apiKey, verifyTls: t.verifyTls });
	return r.ok ? { ...r, kind: 'octoprint' } : r;
}

/** Resolves "auto" to a kind (OctoPrint when nothing answers, so the old error messages apply). */
export async function resolveKind(t: Omit<TestTarget, 'kind'> & { kind: unknown }): Promise<PrinterKind> {
	if (t.kind === 'octoprint' || t.kind === 'moonraker') return t.kind;
	return (await detectKind(t)).kind ?? 'octoprint';
}
