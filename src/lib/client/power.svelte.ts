/**
 * Smart plug state for the sidebar, overview and printer page (polled from /api/power),
 * and the power actions with their confirmations: turning off asks once when the printer
 * is hot and twice while it prints (the server insists on both; see the power API).
 */
import { api, ApiError, errorMessage } from './api.ts';
import { confirmAction, toast } from './state.svelte.ts';
import { formatCountdown, type PowerInfo } from '#lib/power.ts';

/** Plug info per printer id (printers without a plug are absent). */
export const plugs = $state<Record<string, PowerInfo>>({});
export const plugsLoaded = $state({ value: false });

let timer: ReturnType<typeof setInterval> | undefined;
let users = 0;

export async function refreshPower() {
	try {
		const list = await api.get<PowerInfo[]>('/api/power');
		for (const p of list) plugs[p.printerId] = p;
		for (const id of Object.keys(plugs)) if (!list.some((p) => p.printerId === id)) delete plugs[id];
		plugsLoaded.value = true;
	} catch {
		// Signed out or offline; try again next tick.
	}
}

/** Polls plug state (reference-counted); returns the stop function. */
export function pollPower(everyMs = 5_000): () => void {
	users++;
	if (!timer) {
		void refreshPower();
		timer = setInterval(() => {
			if (document.visibilityState === 'visible') void refreshPower();
		}, everyMs);
	}
	return () => {
		users--;
		if (users <= 0 && timer) {
			clearInterval(timer);
			timer = undefined;
			users = 0;
		}
	};
}

const url = (id: string) => `/api/printers/${encodeURIComponent(id)}/power`;

function apply(id: string, r: { plug?: PowerInfo | null }) {
	if (r?.plug) plugs[id] = r.plug;
}

export async function powerOn(id: string, name: string): Promise<boolean> {
	try {
		apply(id, await api.post(url(id), { action: 'on' }));
		toast('success', `${name} powered on`, plugs[id]?.settings.autoConnect ? 'Connecting to the printer once it’s up…' : undefined);
		return true;
	} catch (err) {
		toast('error', 'Could not power on', errorMessage(err));
		return false;
	}
}

/**
 * Turns the printer off, confirming whatever the server asks for: a hot printer once,
 * a printing one twice (`confirm`, then `confirmPrinting`).
 */
export async function powerOff(id: string, name: string): Promise<boolean> {
	const body: Record<string, unknown> = { action: 'off' };
	for (let round = 0; round < 3; round++) {
		try {
			apply(id, await api.post(url(id), body));
			toast('success', `${name} powered off`);
			return true;
		} catch (err) {
			const d = err instanceof ApiError ? (err.detail as { confirmRequired?: boolean; confirmField?: string; title?: string; stage?: string } | undefined) : undefined;
			if (!(err instanceof ApiError && err.status === 409 && d?.confirmRequired && d.confirmField)) {
				toast('error', 'Could not power off', errorMessage(err));
				return false;
			}
			const final = d.stage === 'printing-final';
			const ok = await confirmAction({
				title: d.title ?? 'Turn the printer off?',
				body: err.message,
				detail: final ? `${name}: the print is lost` : undefined,
				confirmLabel: final ? 'Cut power now' : d.stage === 'printing' ? 'Continue' : 'Power off',
				danger: true
			});
			if (!ok) return false;
			body[d.confirmField] = true;
		}
	}
	return false;
}

export async function keepOn(id: string): Promise<boolean> {
	try {
		apply(id, await api.post(url(id), { action: 'keep_on' }));
		toast('success', 'Kept on', 'Auto power-off cancelled for this print.');
		return true;
	} catch (err) {
		toast('error', 'Could not cancel the auto power-off', errorMessage(err));
		return false;
	}
}

/** A clock for countdowns, ticking every second while something shows one. */
export const clock = $state({ now: Date.now() });
let clockTimer: ReturnType<typeof setInterval> | undefined;
let clockUsers = 0;

export function tickClock(): () => void {
	clockUsers++;
	clock.now = Date.now();
	clockTimer ??= setInterval(() => (clock.now = Date.now()), 1_000);
	return () => {
		clockUsers--;
		if (clockUsers <= 0 && clockTimer) {
			clearInterval(clockTimer);
			clockTimer = undefined;
			clockUsers = 0;
		}
	};
}

/** The countdown's text: `Off in 4:12`, or what it waits for. */
export function countdownText(info: PowerInfo, now: number): string {
	const c = info.countdown;
	if (!c) return '';
	const left = c.offAt - now;
	if (c.heldBy) return `Due, held: ${c.heldBy}`;
	if (c.cooling) return `Cooling ${c.hotendC != null ? `${Math.round(c.hotendC)}°` : ''} → ${c.targetC}°${left > 0 ? ` · off in ≥ ${formatCountdown(left)}` : ''}`;
	return left > 0 ? `Off in ${formatCountdown(left)}` : 'Powering off…';
}
