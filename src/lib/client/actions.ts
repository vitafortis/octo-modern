/**
 * Printer actions from the browser, with the confirmations the server insists on
 * (it answers 409 `confirmRequired` without `confirm: true`). Each resolves true when
 * the action was sent; failures and cancellations show a toast and resolve false.
 */
import { api, ApiError, errorMessage } from './api.ts';
import { confirmAction, toast } from './state.svelte.ts';

type Confirm = Parameters<typeof confirmAction>[0];

/** POSTs an action; asks first when `ask` is given, or when the server says it needs confirming. */
export async function act(url: string, body: Record<string, unknown>, opts: { ask?: Confirm; done?: string; failed: string }): Promise<boolean> {
	if (opts.ask && !(await confirmAction(opts.ask))) return false;
	try {
		await api.post(url, opts.ask ? { ...body, confirm: true } : body);
	} catch (err) {
		if (err instanceof ApiError && err.status === 409 && err.detail?.confirmRequired) {
			const ok = await confirmAction({ title: 'Are you sure?', body: err.message, confirmLabel: 'Do it anyway', danger: true });
			if (!ok) return false;
			try {
				await api.post(url, { ...body, confirm: true });
			} catch (err2) {
				toast('error', opts.failed, errorMessage(err2));
				return false;
			}
		} else {
			toast('error', opts.failed, errorMessage(err));
			return false;
		}
	}
	if (opts.done) toast('success', opts.done);
	return true;
}

const base = (id: string) => `/api/printers/${encodeURIComponent(id)}`;

export type JobCommand = 'start' | 'pause' | 'resume' | 'cancel' | 'restart';

export function jobCommand(id: string, command: JobCommand, file?: string | null) {
	const ask: Confirm | undefined =
		command === 'cancel'
			? { title: 'Cancel this print?', body: 'The print stops and can’t be resumed. Heaters follow OctoPrint’s cancel script.', detail: file ?? undefined, confirmLabel: 'Cancel print', danger: true }
			: command === 'restart'
				? { title: 'Restart this print from the beginning?', detail: file ?? undefined, confirmLabel: 'Restart' }
				: undefined;
	const done: Record<JobCommand, string> = { start: 'Print started', pause: 'Pausing…', resume: 'Resuming…', cancel: 'Cancelling…', restart: 'Print restarted' };
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

/** Sends G-code; the server asks for confirmation while printing. */
export function sendGcode(id: string, commands: string[]) {
	return act(`${base(id)}/command`, { commands }, { failed: 'Could not send G-code' });
}

export function emergencyStop(id: string, name: string) {
	return act(
		`${base(id)}/command`,
		{ commands: ['M112'] },
		{
			ask: {
				title: `Emergency stop ${name}?`,
				body: 'Sends M112: the firmware halts heaters and motors immediately. The printer has to be reset (power-cycled or reconnected) afterwards, and a running print is lost.',
				detail: 'M112',
				confirmLabel: 'Emergency stop',
				danger: true
			},
			done: 'Emergency stop sent',
			failed: 'Could not send the emergency stop'
		}
	);
}
