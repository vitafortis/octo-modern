/**
 * Starting prints with the pre-print steps in front: every start octo·modern makes
 * (Files, the job buttons, print-after-upload, library send-and-print, the queue, slicer
 * uploads, "print again") goes through `prep.begin()`.
 *
 * - Nothing configured for the printer (the default), or "skip this time": the file
 *   starts right away, exactly as before.
 * - Otherwise the start of the file is read and a plan made (./head.ts, #lib/preprint.ts):
 *   heat the bed, level, the snippet, each only when the file doesn't do it itself.
 *   When something runs, the printer shows "Preparing" (LiveSnapshot.preparing) while
 *   each step runs to completion (./runner.ts); then the file starts. Failure, a
 *   timeout or Cancel leave the file unstarted; failures send `print.prestart_failed`.
 *   Everything is audit-logged.
 * - One preparation per printer at a time; the queue treats a preparing printer as busy.
 * - Prints started in OctoPrint's or Mainsail's own UI don't pass through here.
 */
import { randomUUID } from 'node:crypto';
import { printers } from '../octoprint/manager.ts';
import { OctoPrintError } from '../octoprint/errors.ts';
import { audit } from '../permissions.ts';
import { currentState, refreshSoon } from '../control.ts';
import { notify } from '../notify/index.ts';
import { MoonrakerBackend } from '../moonraker/backend.ts';
import type { Origin, PrinterBackend } from '../backend/types.ts';
import { readHead } from './head.ts';
import { resolvedFor } from './settings.ts';
import { moonrakerRunner, octoprintRunner, PrepError, type StepRunner } from './runner.ts';
import { buildPlan, planRuns, stepStatus, type PrepPlan, type PrepStep, type Preparing } from '#lib/preprint.ts';
import { STATE_LABEL } from '#lib/printer.ts';
import type { Printer, User } from '#lib/types.ts';

type Locals = { user: User | null; ip?: string };

export interface StartTarget {
	printer: Printer;
	backend: PrinterBackend;
	origin: Origin;
	/** The file (for 'start'/'restart': the selected or last file, to read and to name). */
	path: string;
	/**
	 * How the file starts once the printer is ready: `select` selects and prints it,
	 * `start`/`restart` send that job command (the file is already selected).
	 */
	how: 'select' | 'start' | 'restart';
	locals: Locals;
	/** Where the start came from, for the audit log (files, job, upload, library, queue, slicer…). */
	via: string;
}

export interface BeginResult {
	/** Steps run first; the file starts when `done` resolves. */
	preparing: boolean;
	/** Resolves once the file has started; rejects (PrepError) when it won't. */
	done: Promise<void>;
	plan: PrepPlan | null;
}

interface Active {
	prep: Preparing;
	abort: AbortController;
	cancelledBy: Locals | null;
}

const NOT_CONFIGURED: PrepPlan = { configured: false, steps: [], headRead: false };
const who = (l: Locals) => l.user?.name || l.user?.email || null;
const baseName = (p: string) => p.split('/').pop() || p;

/** The `print.prestart_failed` notification; tests replace `prep.notify`. */
export async function notifyPrestartFailed(o: { printer: Printer; file: string; step: PrepStep | null; error: PrepError }): Promise<void> {
	const what = o.step ? (o.step.kind === 'snippet' ? 'The pre-print G-code' : o.step.kind === 'level' ? 'Bed leveling' : 'Heating the bed') : 'Starting';
	await notify({
		kind: 'print.prestart_failed',
		printerId: o.printer.id,
		printerName: o.printer.name,
		title: `Print not started: ${o.printer.name}`,
		message: `${o.file} wasn’t started on ${o.printer.name}. ${what} failed: ${o.error.message}.${o.error.hint ? ` ${o.error.hint}` : ''}`,
		fields: [
			{ label: 'File', value: o.file },
			...(o.step ? [{ label: 'Step', value: `${o.step.label}: ${o.step.commands.join(' · ')}`.slice(0, 300) }] : [])
		],
		data: { file: o.file, step: o.step?.kind ?? null, code: o.error.code },
		dedupeKey: `${o.file}:${Date.now()}`
	});
}

class PrepService {
	private running = new Map<string, Active>();
	/** Set by tests to observe notifications. */
	notify: typeof notifyPrestartFailed = notifyPrestartFailed;
	/** Set by tests to run steps without a printer. */
	runnerOverride: ((printer: Printer, backend: PrinterBackend) => StepRunner) | null = null;

	/** What the printer is being prepared for, if anything. */
	active(printerId: string): Preparing | null {
		return this.running.get(printerId)?.prep ?? null;
	}

	isPreparing(printerId: string): boolean {
		return this.running.has(printerId);
	}

	/** What would run before printing this file (reads the start of the file only when something is configured). */
	async plan(printer: Printer, backend: PrinterBackend, origin: Origin, path: string): Promise<PrepPlan> {
		const r = resolvedFor(printer);
		if (!r.leveling && !r.snippet) return NOT_CONFIGURED;
		const head = await readHead(backend, origin, path);
		return buildPlan(r, head);
	}

	runnerFor(printer: Printer, backend: PrinterBackend): StepRunner {
		if (this.runnerOverride) return this.runnerOverride(printer, backend);
		if (backend instanceof MoonrakerBackend) return moonrakerRunner((script, opts) => backend.runScript(script, opts));
		return octoprintRunner({
			send: (commands) => backend.sendCommands(commands),
			feed: {
				subscribe: (fn) => printers.subscribe(printer.id, fn),
				live: () => printers.pushState(printer.id) === 'open',
				state: () => printers.snapshot(printer.id)?.state
			}
		});
	}

	private refuseIfBusy(printer: Printer) {
		if (this.running.has(printer.id)) {
			throw new OctoPrintError(`${printer.name} is being prepared for another print`, { status: 409, code: 'PREPARING', hint: 'Wait for it, or cancel the preparation on the printer’s page.' });
		}
	}

	/**
	 * Starts a print: right away when nothing needs to run first (or `skip`), otherwise
	 * after the plan's steps, in the background. Throws (409) while the printer is being
	 * prepared for another print; errors starting the file directly are thrown too.
	 */
	async begin(t: StartTarget, opts: { plan?: PrepPlan; skip?: boolean } = {}): Promise<BeginResult> {
		this.refuseIfBusy(t.printer);
		// A paused OctoPrint job restarted from the top: its part is still on the bed, so no probing.
		const plan = opts.skip || (t.how === 'restart' && t.printer.kind === 'octoprint') ? null : (opts.plan ?? (await this.plan(t.printer, t.backend, t.origin, t.path)));
		if (opts.skip) {
			const r = resolvedFor(t.printer);
			if (r.leveling || r.snippet) audit(t.locals, 'preprint.skip', { printer: t.printer, detail: `${t.path} (skipped by request)` });
		}
		if (!plan || !planRuns(plan)) {
			if (plan?.configured) audit(t.locals, 'preprint.skip', { printer: t.printer, detail: `${t.path}: ${plan.steps.map((s) => `${s.label}: ${s.reason}`).join('; ')}`.slice(0, 480) });
			await this.startFile(t);
			return { preparing: false, done: Promise.resolve(), plan };
		}
		const state = await currentState(t.printer.id, t.backend);
		if (state !== 'operational') throw new OctoPrintError(`${t.printer.name} isn’t ready to print (${STATE_LABEL[state].toLowerCase()})`, { status: 409, code: 'NOT_READY' });
		this.refuseIfBusy(t.printer);
		const active: Active = {
			prep: { id: randomUUID(), file: baseName(t.path), step: 'checking', label: stepStatus('checking'), startedAt: Date.now(), by: who(t.locals) },
			abort: new AbortController(),
			cancelledBy: null
		};
		this.running.set(t.printer.id, active);
		this.publish(t.printer.id, active.prep);
		const steps = plan.steps.filter((s) => s.run);
		audit(t.locals, 'preprint.start', { printer: t.printer, detail: `${t.path}: ${steps.map((s) => `${s.label} (${s.commands.join(', ')})`).join(' → ')}`.slice(0, 480) });
		const done = this.run(t, steps, active);
		done.catch(() => {});
		return { preparing: true, done, plan };
	}

	/** Cancels a preparation; the file isn't started. False when nothing was being prepared. */
	cancel(printerId: string, locals: Locals): boolean {
		const a = this.running.get(printerId);
		if (!a) return false;
		a.cancelledBy = locals;
		a.abort.abort();
		return true;
	}

	private publish(printerId: string, prep: Preparing | null) {
		printers.model(printerId)?.setPreparing(prep);
	}

	private async run(t: StartTarget, steps: PrepStep[], a: Active): Promise<void> {
		const { printer } = t;
		const timeoutMs = resolvedFor(printer).timeoutMs;
		const runner = this.runnerFor(printer, t.backend);
		let current: PrepStep | null = null;
		try {
			for (const step of steps) {
				current = step;
				a.prep = { ...a.prep, step: step.kind, label: stepStatus(step.kind) };
				this.publish(printer.id, a.prep);
				await runner(step.commands, { signal: a.abort.signal, timeoutMs });
			}
			current = null;
			if (a.abort.signal.aborted) throw new PrepError('Cancelled', 'CANCELLED');
			a.prep = { ...a.prep, step: 'starting', label: stepStatus('starting') };
			this.publish(printer.id, a.prep);
			const state = await currentState(printer.id, t.backend);
			const ok = state === 'operational' || (t.how === 'restart' && state === 'paused');
			if (!ok) throw new PrepError(`The printer isn’t ready to print any more (${state})`, 'STATE');
			if (a.abort.signal.aborted) throw new PrepError('Cancelled', 'CANCELLED');
			try {
				await this.startFile(t);
			} catch (err) {
				throw new PrepError(`Couldn’t start the file: ${(err as Error).message}`, 'FAILED', (err as { hint?: string }).hint);
			}
			audit(t.locals, 'preprint.done', { printer, detail: `${t.path} (${Math.round((Date.now() - a.prep.startedAt) / 1000)} s)` });
		} catch (err) {
			const e = err instanceof PrepError ? err : new PrepError((err as Error).message || String(err), 'FAILED');
			if (e.code === 'CANCELLED' || a.abort.signal.aborted) {
				audit(a.cancelledBy ?? t.locals, 'preprint.cancel', { printer, detail: `${t.path}${current ? ` during “${current.label}”` : ''}; the file wasn’t started` });
				throw new PrepError('Cancelled before the print started', 'CANCELLED');
			}
			audit(t.locals, 'preprint.fail', { printer, detail: `${t.path}${current ? `, ${current.label}` : ''}: ${e.message}`.slice(0, 480) });
			await this.notify({ printer, file: baseName(t.path), step: current, error: e }).catch(() => {});
			throw e;
		} finally {
			if (this.running.get(printer.id) === a) this.running.delete(printer.id);
			this.publish(printer.id, null);
			refreshSoon(printer.id);
		}
	}

	/** Starts the file itself and records who did it (the history attributes prints by this). */
	private async startFile(t: StartTarget) {
		if (t.how === 'select') await t.backend.selectFile(t.origin, t.path, true);
		else await t.backend.jobCommand(t.how);
		audit(t.locals, t.how === 'select' ? 'job.start' : `job.${t.how}`, { printer: t.printer, detail: `${t.origin === 'sdcard' ? 'SD: ' : ''}${t.path}` });
		refreshSoon(t.printer.id);
	}
}

const KEY = Symbol.for('octo-modern.preprint');
type G = typeof globalThis & { [KEY]?: PrepService };

/** The process-wide pre-print service (survives dev-server module reloads). */
export const prep: PrepService = ((globalThis as G)[KEY] ??= new PrepService());

// --- for routes -----------------------------------------------------------------------------

/** The `preprint` choice in a start request: run the steps, skip them this time, or not given yet. */
export function prepChoice(raw: unknown): 'run' | 'skip' | undefined {
	return raw === 'run' || raw === 'skip' ? raw : undefined;
}

/**
 * 409 asking to confirm the start with the plan shown (the client resends with
 * `preprint: 'run' | 'skip'`). Only when something is configured for the printer.
 */
export function prepConfirmRequired(plan: PrepPlan, file: string): Response {
	return Response.json(prepConfirmBody(plan, file), { status: 409 });
}

/** The body of that 409 (also what an MCP start answers with until `preprint` is chosen). */
export function prepConfirmBody(plan: PrepPlan, file: string) {
	const runs = planRuns(plan);
	return {
		message: runs
			? 'Before the file starts, octo·modern runs the steps marked below and waits for each to finish. The printer shows “Preparing” meanwhile, with Cancel.'
			: 'Everything set to run before a print is already in this file, so it starts right away.',
		confirmRequired: true as const,
		title: `Print ${file}?`,
		confirmLabel: runs ? 'Prepare and print' : 'Print',
		preprint: { steps: plan.steps.map(({ kind, label, run, reason, commands }) => ({ kind, label, run, reason, commands })), headRead: plan.headRead }
	};
}
