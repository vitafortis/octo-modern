import { api } from './api.ts';
import type { LiveSnapshot } from '#lib/printer.ts';
import type { Printer, Viewer } from '#lib/types.ts';

type Toast = { id: number; kind: 'info' | 'success' | 'error'; title: string; body?: string };

let nextToast = 1;
export const toasts = $state<Toast[]>([]);

export function toast(kind: Toast['kind'], title: string, body?: string) {
	const id = nextToast++;
	toasts.push({ id, kind, title, body });
	setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 3500);
}

export function dismiss(id: number) {
	const i = toasts.findIndex((t) => t.id === id);
	if (i !== -1) toasts.splice(i, 1);
}

/** Printers the user can see, shared by the sidebar and pages. */
export const printers = $state<{ list: Printer[]; loaded: boolean }>({ list: [], loaded: false });

export async function refreshPrinters() {
	printers.list = await api.get<Printer[]>('/api/printers');
	printers.loaded = true;
}

/**
 * Latest snapshot per printer for the sidebar and overview, polled from
 * /api/printers/status. A printer page's live stream also writes here, so the
 * sidebar reflects it immediately.
 */
export const statuses = $state<Record<string, LiveSnapshot>>({});

let statusTimer: ReturnType<typeof setInterval> | undefined;
let statusUsers = 0;

export async function refreshStatuses() {
	try {
		const list = await api.get<LiveSnapshot[]>('/api/printers/status');
		for (const s of list) {
			// A live stream may be ahead of the poll; keep the newer one.
			if (!statuses[s.id] || statuses[s.id].updatedAt <= s.updatedAt) statuses[s.id] = s;
		}
		for (const id of Object.keys(statuses)) if (!list.some((s) => s.id === id)) delete statuses[id];
	} catch {
		// Offline or signed out; the next tick tries again.
	}
}

/** Starts polling statuses (reference-counted); returns the stop function. */
export function pollStatuses(everyMs = 5_000): () => void {
	statusUsers++;
	if (!statusTimer) {
		void refreshStatuses();
		statusTimer = setInterval(() => {
			if (document.visibilityState === 'visible') void refreshStatuses();
		}, everyMs);
	}
	return () => {
		statusUsers--;
		if (statusUsers <= 0 && statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
			statusUsers = 0;
		}
	};
}

export const theme = $state<{ value: 'dark' | 'light' }>({ value: 'dark' });

export function setTheme(value: 'dark' | 'light') {
	theme.value = value;
	document.documentElement.dataset.theme = value;
	document.querySelector<HTMLMetaElement>('meta[name=theme-color]')?.setAttribute('content', value === 'light' ? '#fbfaff' : '#0b0a10');
	try {
		localStorage.setItem('ocm-theme', value);
	} catch {}
}

/** Server form dialog: `null` closed, `'new'` create, or the printer being edited. */
export const editor = $state<{ target: Printer | 'new' | null }>({ target: null });

/** The signed-in user; set by the root layout. */
export const session = $state<{ viewer: Viewer | null }>({ viewer: null });

export const isAdmin = () => session.viewer?.role === 'admin';
/** Operators and admins control printers (per printer, see `printer.access.control`). */
export const canOperate = () => session.viewer?.role === 'admin' || session.viewer?.role === 'operator';

type ConfirmRequest = {
	title: string;
	body?: string;
	/** Monospace detail, e.g. the G-code about to be sent. */
	detail?: string;
	confirmLabel?: string;
	danger?: boolean;
	/** Steps to list (the pre-print plan): what runs and why. */
	steps?: { label: string; run: boolean; reason: string; commands: string[] }[];
	/** A checkbox under the body; its value comes back with the answer. */
	option?: { label: string; hint?: string };
	resolve: (ok: boolean, option?: boolean) => void;
};

/** The open confirmation dialog, rendered once by the root layout. */
export const confirmation = $state<{ request: ConfirmRequest | null }>({ request: null });

/** Asks the user to confirm; resolves false if they cancel or dismiss. */
export function confirmAction(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
	confirmation.request?.resolve(false);
	return new Promise((resolve) => (confirmation.request = { ...opts, resolve: (ok) => resolve(ok) }));
}

/** Like confirmAction, with the state of `opts.option`'s checkbox. */
export function confirmWithOption(opts: Omit<ConfirmRequest, 'resolve'>): Promise<{ ok: boolean; option: boolean }> {
	confirmation.request?.resolve(false);
	return new Promise((resolve) => (confirmation.request = { ...opts, resolve: (ok, option) => resolve({ ok, option: !!option }) }));
}
