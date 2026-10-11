/**
 * Printer actions from the browser, with the confirmations the server insists on
 * (it answers 409 `confirmRequired` without `confirm: true`). Each resolves true when
 * the action was sent; failures and cancellations show a toast and resolve false.
 */
import { api, ApiError, errorMessage } from './api.ts';
import { confirmAction, confirmWithOption, toast } from './state.svelte.ts';

type Confirm = Parameters<typeof confirmAction>[0];

type Step = { label: string; run: boolean; reason: string; commands: string[] };

/**
 * Answers a 409 `confirmRequired`: a plain question, or the pre-print plan (with "skip
 * them this time"). Returns what to add to the request, or null when the user declined.
 */
async function answer(err: ApiError): Promise<Record<string, unknown> | null> {
	const d: NonNullable<ApiError["detail"]> = err.detail ?? { message: err.message };
	const plan = d.preprint as { steps: Step[] } | undefined;
	if (plan) {
		const runs = plan.steps.some((s) => s.run);
		const r = await confirmWithOption({
			title: d.title ?? 'Start the print?',
			body: err.message,
			steps: plan.steps,
			confirmLabel: d.confirmLabel ?? 'Print',
			option: runs ? { label: 'Skip the pre-print steps this time', hint: 'Starts the file right away, as it is.' } : undefined
		});
		return r.ok ? { preprint: r.option ? 'skip' : 'run' } : null;
	}
	const ok = await confirmAction({ title: d.title ?? 'Are you sure?', body: err.message, confirmLabel: d.confirmLabel ?? 'Do it anyway', danger: true });
	return ok ? { confirm: true } : null;
}

/**
 * POSTs an action; asks first when `ask` is given, or when the server says it needs
 * confirming (several questions in a row are fine: a spool warning, then the pre-print
 * plan). A start that runs pre-print steps first toasts "Preparing" instead of `done`.
 */
export async function act(url: string, body: Record<string, unknown>, opts: { ask?: Confirm; done?: string; failed: string }): Promise<boolean> {
	if (opts.ask && !(await confirmAction(opts.ask))) return false;
	let req = opts.ask ? { ...body, confirm: true } : body;
	let res: { preparing?: boolean } | undefined;
	for (let attempt = 0; ; attempt++) {
		try {
			res = await api.post<{ preparing?: boolean }>(url, req);
			break;
		} catch (err) {
			if (attempt < 3 && err instanceof ApiError && err.status === 409 && err.detail?.confirmRequired) {
				const more = await answer(err);
				if (!more) return false;
				req = { ...req, ...more };
				continue;
			}
			toast('error', opts.failed, errorMessage(err));
			return false;
		}
	}
	if (res?.preparing) toast('info', 'Preparing the printer', 'The print starts once the pre-print steps have finished.');
	else if (opts.done) toast('success', opts.done);
	return true;
}

const base = (id: string) => `/api/printers/${encodeURIComponent(id)}`;

export type JobCommand = 'start' | 'pause' | 'resume' | 'cancel' | 'restart';

export async function jobCommand(id: string, command: JobCommand, file?: string | null) {
	const ask: Confirm | undefined =
		command === 'cancel' ? { title: 'Cancel this print?', body: 'The print stops and can’t be resumed. Heaters follow OctoPrint’s cancel script.', detail: file ?? undefined, confirmLabel: 'Cancel print', danger: true } : undefined;
	const done: Record<JobCommand, string> = { start: 'Print started', pause: 'Pausing…', resume: 'Resuming…', cancel: 'Cancelling…', restart: 'Print restarted' };
	// Restart asks here, then lets the server ask too (like start) when a spool won't last the print.
	if (command === 'restart' && !(await confirmAction({ title: 'Restart this print from the beginning?', detail: file ?? undefined, confirmLabel: 'Restart' }))) return false;
	return act(`${base(id)}/job`, { command }, { ask, done: done[command], failed: `Could not ${command} the job` });
}

export function setTargets(id: string, targets: Record<string, number>) {
	return act(`${base(id)}/temperature`, { targets }, { failed: 'Could not set the temperature' });
}

export function connectPrinter(id: string, opts: { port?: string; baudrate?: number; printerProfile?: string }) {
	return act(`${base(id)}/connection`, { command: 'connect', ...opts }, { done: 'Connecting…', failed: 'Could not connect' });
}

export function disconnectPrinter(id: string, printing: boolean) {
	return act(
		`${base(id)}/connection`,
		{ command: 'disconnect' },
		{
			ask: printing ? { title: 'Disconnect during a print?', body: 'Disconnecting the printer stops the running print.', confirmLabel: 'Disconnect', danger: true } : undefined,
			done: 'Disconnected',
			failed: 'Could not disconnect'
		}
	);
}

/** Klipper: FIRMWARE_RESTART (or RESTART, which only reloads the host); the server asks first mid-print. */
export function restartKlipper(id: string, command: 'firmware_restart' | 'restart' = 'firmware_restart') {
	return act(`${base(id)}/connection`, { command }, { done: command === 'restart' ? 'Restarting Klipper…' : 'Firmware restart sent', failed: 'Could not restart Klipper' });
}

/** Sends G-code; the server asks for confirmation while printing. */
export function sendGcode(id: string, commands: string[]) {
	return act(`${base(id)}/command`, { commands }, { failed: 'Could not send G-code' });
}

export function emergencyStop(id: string, name: string, klipper = false) {
	return act(
		`${base(id)}/command`,
		{ commands: ['M112'] },
		{
			ask: {
				title: `Emergency stop ${name}?`,
				body: klipper
					? 'Klipper’s emergency stop: heaters and motors halt immediately and Klipper shuts down. Bring it back with a firmware restart; a running print is lost.'
					: 'Sends M112: the firmware halts heaters and motors immediately. The printer has to be reset (power-cycled or reconnected) afterwards, and a running print is lost.',
				detail: 'M112',
				confirmLabel: 'Emergency stop',
				danger: true
			},
			done: 'Emergency stop sent',
			failed: 'Could not send the emergency stop'
		}
	);
}

/** Cancels the pre-print steps running on a printer; the file isn't started. */
export async function cancelPreparation(id: string, file?: string | null): Promise<boolean> {
	const ok = await confirmAction({
		title: 'Cancel the preparation?',
		body: 'The print won’t start. A command the printer is already running (a probing pass, say) finishes first; use the emergency stop to halt it.',
		detail: file ?? undefined,
		confirmLabel: 'Cancel preparation',
		danger: true
	});
	if (!ok) return false;
	try {
		await api.del(`${base(id)}/preprint`);
		toast('success', 'Preparation cancelled', 'The print won’t start.');
		return true;
	} catch (err) {
		toast('error', 'Could not cancel', errorMessage(err));
		return false;
	}
}
