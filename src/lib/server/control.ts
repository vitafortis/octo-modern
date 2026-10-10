/**
 * Shared plumbing for routes that act on a printer: permission check, client, a
 * refresh afterwards, and the server-side rule that dangerous actions need an
 * explicit `confirm: true` (the UI asks first; this keeps scripts honest too).
 */
import { json } from '@sveltejs/kit';
import { BadRequest } from './http.ts';
import { clientFor, printers } from './octoprint/manager.ts';
import { requireControl, requirePrinter } from './permissions.ts';
import type { OctoPrintClient } from './octoprint/client.ts';
import type { Printer, User } from '#lib/types.ts';
import type { PrinterState } from '#lib/printer.ts';
import { parseJobResponse } from './octoprint/parse.ts';

export interface Target {
	printer: Printer;
	client: OctoPrintClient;
}

/** For actions: the printer (if the user may control it) and its client. */
export function controlTarget(user: User | null, id: string): Target {
	const printer = requireControl(user, id);
	return { printer, client: clientFor(printer) };
}

/** For reads: the printer (if the user may see it) and its client. */
export function viewTarget(user: User | null, id: string): Target {
	const printer = requirePrinter(user, id);
	return { printer, client: clientFor(printer) };
}

/**
 * The printer's state right now, for safety rules like "confirm while printing".
 * Asks OctoPrint directly: the live snapshot can trail it by a second or two.
 */
export async function currentState(id: string, client: OctoPrintClient): Promise<PrinterState> {
	try {
		const state = parseJobResponse(await client.job()).state?.state;
		if (state && state !== 'unknown') return state;
	} catch {
		// Fall back to what we last saw.
	}
	return printers.snapshot(id)?.state ?? 'unknown';
}

/** Polls soon after an action so watchers without a push connection see the effect. */
export function refreshSoon(id: string, delays = [400, 1500]) {
	for (const ms of delays) setTimeout(() => void printers.poll(id), ms).unref?.();
}

/** 409 asking the client to confirm and resend with `confirm: true`. */
export function confirmRequired(message: string): Response {
	return json({ message, confirmRequired: true }, { status: 409 });
}

// --- input validation ------------------------------------------------------------

/** Upper bounds, generous enough for high-temperature machines. */
const MAX: Record<string, number> = { tool: 450, bed: 200, chamber: 120 };

export function validTargets(raw: unknown): Record<string, number> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequest('"targets" must be an object like { "tool0": 210, "bed": 60 }');
	const out: Record<string, number> = {};
	for (const [heater, v] of Object.entries(raw)) {
		if (!/^(tool\d{1,2}|bed|chamber)$/.test(heater)) throw new BadRequest(`Unknown heater "${heater}"`);
		const n = Number(v);
		const max = MAX[heater.startsWith('tool') ? 'tool' : heater];
		if (!Number.isFinite(n) || n < 0 || n > max) throw new BadRequest(`${heater} target must be 0–${max} °C`);
		out[heater] = Math.round(n * 10) / 10;
	}
	if (!Object.keys(out).length) throw new BadRequest('Nothing to set');
	return out;
}

/** Lines that stop the machine immediately (firmware emergency stop). */
export const isEmergencyStop = (line: string) => /^\s*M112\b/i.test(line);

export function parseCommands(raw: unknown): string[] {
	const list = typeof raw === 'string' ? raw.split(/\r?\n/) : Array.isArray(raw) ? raw : null;
	if (!list) throw new BadRequest('"commands" must be a string or a list of strings');
	const lines = list
		.filter((l): l is string => typeof l === 'string')
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith(';'));
	if (!lines.length) throw new BadRequest('No G-code to send');
	if (lines.length > 200) throw new BadRequest('Send at most 200 lines at once (upload a file for more)');
	if (lines.some((l) => l.length > 256)) throw new BadRequest('A line is longer than 256 characters');
	return lines;
}

