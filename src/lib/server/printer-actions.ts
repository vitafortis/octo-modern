/**
 * Printer actions shared by the API routes and the MCP server (mcp/tools.ts): job
 * commands, printing a file, and heater targets. Each takes a printer the caller may
 * control (control.ts `controlTarget`) and the acting `locals` (who, from where, and
 * for MCP calls `via`, which the audit log shows).
 *
 * Steps that need a confirmation don't act: they answer `{ ok: false, confirm }` with
 * what the 409 `confirmRequired` body says (routes send it as is; MCP turns it into a
 * tool result telling the model what to send next).
 */
import { json } from '@sveltejs/kit';
import { BadRequest } from './http.ts';
import { refreshSoon, validTargets, type Target } from './control.ts';
import { audit } from './permissions.ts';
import { printers } from './octoprint/manager.ts';
import { ensurePrinterOn } from './power/service.ts';
import { prep, prepChoice, prepConfirmBody } from './preprint/service.ts';
import { filamentWarning, needForFile, perToolMm, wantsFilamentCheck } from './spools/check.ts';
import { FILAMENT_ASK } from '#lib/spools.ts';
import { isConnected } from '#lib/printer.ts';
import type { User } from '#lib/types.ts';

type Locals = { user: User | null; ip?: string; via?: string };

/** What a 409 asks for: `confirm: true` (cancel, filament) or a `preprint` choice. */
export interface ConfirmAsk {
	message: string;
	confirmRequired: true;
	title?: string;
	confirmLabel?: string;
	/** Present when the pre-print plan is what needs confirming (send `preprint: 'run' | 'skip'`). */
	preprint?: ReturnType<typeof prepConfirmBody>['preprint'];
}

export type ActionOutcome = { ok: true; preparing?: boolean } | { ok: false; confirm: ConfirmAsk };

/** A route's answer: 200 `{ ok, preparing? }`, or 409 with what to confirm. */
export function outcomeResponse(o: ActionOutcome): Response {
	return o.ok ? json(o) : json(o.confirm, { status: 409 });
}

const ask = (message: string, extra?: { title: string; confirmLabel?: string }): ActionOutcome => ({ ok: false, confirm: { message, confirmRequired: true, ...extra } });

export const JOB_COMMANDS = ['start', 'pause', 'resume', 'cancel', 'restart'] as const;
export type JobCommandName = (typeof JOB_COMMANDS)[number];

/**
 * Job control: start | pause | resume | cancel | restart. Cancelling needs `confirm`;
 * so does starting or restarting when an active Spoolman spool holds less filament than
 * the file needs. Starting (and Klipper's restart, which prints the last file again)
 * runs the pre-print steps first when they're set up, after the plan is confirmed
 * (`preprint: 'run' | 'skip'`). Restarting a paused OctoPrint job skips them: its part
 * is still on the bed.
 */
export async function jobCommand(t: Target, locals: Locals, command: JobCommandName, opts: { confirm?: boolean; preprint?: unknown } = {}): Promise<ActionOutcome> {
	const { printer, backend } = t;
	if (!JOB_COMMANDS.includes(command)) throw new BadRequest(`"command" must be one of ${JOB_COMMANDS.join(', ')}`);
	if (command === 'cancel' && opts.confirm !== true) return ask('Cancelling ends the print and can’t be undone. Send confirm: true to cancel.');
	const starting = command === 'start' || command === 'restart';
	const job = starting ? ((await backend.status().catch(() => null))?.job ?? null) : null;
	if (starting && opts.confirm !== true && wantsFilamentCheck(printer.id)) {
		let perTool = perToolMm(job?.filament);
		// Klipper's status has no analysis: ask for the file's slicer metadata.
		if (!Object.keys(perTool).length && job?.file) perTool = (await backend.fileDetails(job.file.origin === 'sdcard' ? 'sdcard' : 'local', job.file.path))?.perTool ?? {};
		const warning = Object.keys(perTool).length ? await filamentWarning(printer.id, { perTool }) : null;
		if (warning) return ask(warning, FILAMENT_ASK);
	}
	const file = job?.file ?? printers.snapshot(printer.id)?.job?.file ?? null;
	if (starting && file) {
		const origin = file.origin === 'sdcard' ? 'sdcard' : 'local';
		const choice = prepChoice(opts.preprint);
		const paused = command === 'restart' && printer.kind === 'octoprint';
		const plan = choice === 'skip' || paused ? undefined : await prep.plan(printer, backend, origin, file.path);
		if (!choice && plan?.configured) return { ok: false, confirm: prepConfirmBody(plan, file.display || file.name) };
		const r = await prep.begin({ printer, backend, origin, path: file.path, how: command, locals, via: 'job' }, { plan, skip: choice === 'skip' });
		return { ok: true, preparing: r.preparing };
	}
	const display = printers.snapshot(printer.id)?.job?.file?.display ?? null;
	await backend.jobCommand(command);
	audit(locals, `job.${command}`, { printer, detail: display ?? undefined });
	refreshSoon(printer.id);
	return { ok: true };
}

/** A file path on the printer, checked (no `..`, no leading slash). */
export function printerPath(raw: unknown): string {
	const path = typeof raw === 'string' ? raw.replace(/^\/+/, '') : '';
	if (!path || path.split('/').includes('..')) throw new BadRequest('"path" is required');
	return path;
}

/**
 * Prints a file on the printer (`via` names where the start came from in the audit log).
 * Asks first when an active Spoolman spool won't last the print (`confirm`), and with the
 * plan of what runs first when leveling or pre-print G-code is set up for the printer,
 * until `preprint: 'run' | 'skip'` is sent. `preparing: true`: the steps run now and the
 * file starts after them. A printer on a smart plug with auto power-on is switched on first.
 */
export async function printFile(t: Target, locals: Locals, o: { origin: 'local' | 'sdcard'; path: string; confirm?: boolean; preprint?: unknown; via?: string }): Promise<ActionOutcome> {
	const { printer, backend } = t;
	const { origin, path } = o;
	if (o.confirm !== true && wantsFilamentCheck(printer.id)) {
		const warning = await filamentWarning(printer.id, await needForFile(backend, origin, path));
		if (warning) return ask(warning, FILAMENT_ASK);
	}
	const choice = prepChoice(o.preprint);
	const plan = choice === 'skip' ? undefined : await prep.plan(printer, backend, origin, path);
	if (!choice && plan?.configured) return { ok: false, confirm: prepConfirmBody(plan, path.split('/').pop() ?? path) };
	if (!isConnected(printers.snapshot(printer.id)?.state ?? 'unknown')) await ensurePrinterOn(printer.id, { locals, reason: `to print ${path}` });
	const r = await prep.begin({ printer, backend, origin, path, how: 'select', locals, via: o.via ?? 'files' }, { plan, skip: choice === 'skip' });
	return { ok: true, preparing: r.preparing };
}

/** Sets heater targets (`{ tool0: 210, bed: 60 }`, 0 turns one off) within the limits in control.ts. */
export async function setTemperatures(t: Target, locals: Locals, raw: unknown): Promise<Record<string, number>> {
	const targets = validTargets(raw);
	await t.backend.setTargets(targets);
	audit(locals, 'temperature.set', { printer: t.printer, detail: Object.entries(targets).map(([h, v]) => `${h} → ${v ? `${v} °C` : 'off'}`).join(', ') });
	refreshSoon(t.printer.id);
	return targets;
}
