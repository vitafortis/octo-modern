/**
 * Reconnect delays: exponential from `baseMs`, capped at `maxMs`, with ±`jitter`
 * (a fraction) so several printers that dropped together don't reconnect in lockstep.
 * `attempt` counts failures since the last successful connection, from 0.
 */
export interface BackoffOptions {
	baseMs?: number;
	maxMs?: number;
	factor?: number;
	jitter?: number;
}

export function backoffDelay(attempt: number, opts: BackoffOptions = {}, random: () => number = Math.random): number {
	const { baseMs = 1_000, maxMs = 60_000, factor = 2, jitter = 0.2 } = opts;
	const n = Math.max(0, Math.floor(attempt));
	const raw = Math.min(maxMs, baseMs * factor ** Math.min(n, 30));
	const spread = raw * jitter * (random() * 2 - 1);
	return Math.round(Math.min(maxMs, Math.max(baseMs * (1 - jitter), raw + spread)));
}
