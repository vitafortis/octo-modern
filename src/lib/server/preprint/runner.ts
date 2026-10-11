/**
 * Running one pre-print step and knowing when it has finished, per printer kind.
 *
 * - Klipper: `printer.gcode.script` answers when the script has run (G28, probing,
 *   M190 included), so the request itself is the wait.
 * - OctoPrint: `POST /api/printer/command` returns as soon as the lines are queued. The
 *   step is sent with `M400` (wait for moves to finish) and a marker,
 *   `M118 E1 octo-modern <token> done`, behind it. OctoPrint sends a line only after
 *   the firmware acknowledged the one before (its default), and Marlin acknowledges
 *   G28/G29/M190 only once they're done, so the marker shows up in the terminal log
 *   (as `Send: …`, then as the firmware's echo) exactly when everything before it has
 *   finished. The log comes over OctoPrint's push connection, which is opened for this.
 *   Errors, a disconnect or the timeout end the wait; cancelling sends M108 (which
 *   breaks a heating wait on Marlin) and stops waiting.
 */
import { randomBytes } from 'node:crypto';
import type { LiveEvent } from '../octoprint/model.ts';
import type { PrinterState } from '#lib/printer.ts';

export type PrepErrorCode = 'TIMEOUT' | 'FAILED' | 'CANCELLED' | 'STATE' | 'NO_LIVE';

export class PrepError extends Error {
	readonly code: PrepErrorCode;
	readonly hint?: string;
	constructor(message: string, code: PrepErrorCode, hint?: string) {
		super(message);
		this.code = code;
		this.hint = hint;
	}
}

export interface RunOpts {
	signal: AbortSignal;
	timeoutMs: number;
}

export type StepRunner = (commands: string[], opts: RunOpts) => Promise<void>;

/** What the OctoPrint runner needs from the live feed (the manager in production). */
export interface LogFeed {
	/** Every live event of the printer; opens the push connection while subscribed. */
	subscribe(fn: (e: LiveEvent) => void): () => void;
	/** The push connection is open (log lines arrive). */
	live(): boolean;
	state(): PrinterState | undefined;
}

const BAD_STATES: (PrinterState | undefined)[] = ['error', 'offline', 'disconnected'];
const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
	});

/** A firmware error in OctoPrint's log (not the resend chatter OctoPrint handles itself). */
export function isFirmwareError(line: string): boolean {
	const m = /^Recv:\s*(?:echo:)?(Error:.*|!!.*)$/i.exec(line.trim());
	if (!m) return false;
	return !/checksum|line ?number|resend|expected line|No Line Number/i.test(m[1]);
}

export const markerFor =(token: string) => `M118 E1 octo-modern ${token} done`;

export function octoprintRunner(o: { send: (commands: string[]) => Promise<void>; feed: LogFeed; liveWaitMs?: number; token?: () => string }): StepRunner {
	return async (commands, { signal, timeoutMs }) => {
		if (signal.aborted) throw new PrepError('Cancelled', 'CANCELLED');
		let onEvent: (e: LiveEvent) => void = () => {};
		const off = o.feed.subscribe((e) => onEvent(e));
		try {
			// The push connection carries the terminal log; give it a moment to open.
			const until = Date.now() + (o.liveWaitMs ?? 20_000);
			while (!o.feed.live() && Date.now() < until && !signal.aborted) await sleep(150, signal);
			if (signal.aborted) throw new PrepError('Cancelled', 'CANCELLED');
			if (!o.feed.live()) {
				throw new PrepError('octo·modern couldn’t open OctoPrint’s live connection, which it needs to see when the commands have finished', 'NO_LIVE', 'Check that OctoPrint’s websocket (/sockjs) is reachable through any proxy in between.');
			}
			if (BAD_STATES.includes(o.feed.state())) throw new PrepError(`The printer isn’t ready (${o.feed.state()})`, 'STATE');
			const token = o.token?.() ?? randomBytes(4).toString('hex');
			let stopWait = () => {};
			const done = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new PrepError(`Didn’t finish within ${Math.round(timeoutMs / 60_000) || 1} min`, 'TIMEOUT', 'Raise the timeout under Settings → Before each print if the printer needs longer.')), timeoutMs);
				const onAbort = () => {
					stop();
					// Breaks M190/M109 waits on Marlin (OctoPrint sends M108 past its queue).
					void o.send(['M108']).catch(() => {});
					reject(new PrepError('Cancelled', 'CANCELLED'));
				};
				const stop = () => {
					clearTimeout(timer);
					signal.removeEventListener('abort', onAbort);
				};
				signal.addEventListener('abort', onAbort, { once: true });
				stopWait = stop;
				onEvent = (e) => {
					if (e.type === 'log') {
						const error = e.reset ? null : e.lines.find(isFirmwareError);
						if (error) {
							stop();
							reject(new PrepError(`The printer reported: ${error.replace(/^Recv:\s*/, '')}`, 'FAILED'));
						} else if (e.lines.some((l) => l.includes(token))) {
							stop();
							resolve();
						}
					} else if (e.type === 'update' && BAD_STATES.includes(e.snapshot.state)) {
						stop();
						reject(new PrepError(e.snapshot.printerError ? `The printer reported an error: ${e.snapshot.printerError}` : `The printer went ${e.snapshot.state === 'error' ? 'into an error state' : e.snapshot.state}`, 'STATE'));
					}
				};
			});
			done.catch(() => {});
			try {
				await o.send([...commands, 'M400', markerFor(token)]);
			} catch (err) {
				stopWait();
				throw new PrepError(`OctoPrint refused the commands: ${(err as Error).message}`, 'FAILED', (err as { hint?: string }).hint);
			}
			await done;
		} finally {
			onEvent = () => {};
			off();
		}
	};
}

/** Klipper: one blocking `printer.gcode.script` per step. */
export function moonrakerRunner(run: (script: string, opts: RunOpts) => Promise<void>): StepRunner {
	return async (commands, opts) => {
		if (opts.signal.aborted) throw new PrepError('Cancelled', 'CANCELLED');
		try {
			await run(commands.join('\n'), opts);
		} catch (err) {
			if (opts.signal.aborted) throw new PrepError('Cancelled', 'CANCELLED');
			const e = err as { code?: string; message?: string; hint?: string };
			if (e.code === 'TIMEOUT') throw new PrepError(`Didn’t finish within ${Math.round(opts.timeoutMs / 60_000) || 1} min`, 'TIMEOUT', 'Raise the timeout under Settings → Before each print if the printer needs longer.');
			throw new PrepError(`Klipper reported: ${e.message ?? String(err)}`, 'FAILED', e.hint);
		}
	};
}
