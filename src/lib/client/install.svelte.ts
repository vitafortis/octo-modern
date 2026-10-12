/**
 * "Install app": putting octo·modern on the home screen / in the app list.
 *
 * - Chromium (Android, desktop): the browser fires `beforeinstallprompt` when the app is
 *   installable; it's stashed (app.html catches one fired before the app started) and
 *   `prompt()`ed on click.
 * - iPhone/iPad: no API, so a sheet explains Share → Add to Home Screen.
 * - Already running as an installed app, after `appinstalled`, or in any other browser:
 *   nothing is shown.
 */
import { isIos, standalone } from './push.ts';

interface InstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

const DISMISS_KEY = 'ocm-install-dismissed';

export const install = $state({
	/** How this browser installs: `prompt` (Chromium), `ios` (the Share sheet), or not at all. */
	mode: null as 'prompt' | 'ios' | null,
	/** "Not now" in this browser: the sidebar entry stays hidden (My account still offers it). */
	dismissed: false,
	/** The iOS instructions sheet. */
	sheetOpen: false,
	/** The last answer to the browser's prompt. */
	outcome: null as 'accepted' | 'dismissed' | null
});

let deferred: InstallPromptEvent | null = null;
let started = false;

function readDismissed(): boolean {
	try {
		return localStorage.getItem(DISMISS_KEY) === '1';
	} catch {
		return false;
	}
}

/** Starts listening; call once from the root layout (in the browser). Returns a cleanup. */
export function trackInstall(): () => void {
	if (started) return () => {};
	started = true;
	install.dismissed = readDismissed();
	const w = window as Window & { __ocmInstall?: InstallPromptEvent };
	const onPrompt = (e: Event) => {
		e.preventDefault();
		deferred = e as InstallPromptEvent;
		if (!standalone()) install.mode = 'prompt';
	};
	const onInstalled = () => {
		deferred = null;
		w.__ocmInstall = undefined;
		install.mode = null;
		install.sheetOpen = false;
	};
	if (standalone()) install.mode = null;
	else if (w.__ocmInstall) onPrompt(w.__ocmInstall);
	else if (isIos()) install.mode = 'ios';
	addEventListener('beforeinstallprompt', onPrompt);
	addEventListener('appinstalled', onInstalled);
	return () => {
		started = false;
		removeEventListener('beforeinstallprompt', onPrompt);
		removeEventListener('appinstalled', onInstalled);
	};
}

/** The Install button: the browser's own prompt, or the iOS steps. */
export async function startInstall(): Promise<void> {
	if (install.mode === 'ios') {
		install.sheetOpen = true;
		return;
	}
	const e = deferred;
	if (!e) return;
	// A prompt can be shown only once; Chromium fires a new event if it's still installable.
	deferred = null;
	(window as Window & { __ocmInstall?: unknown }).__ocmInstall = undefined;
	install.mode = null;
	await e.prompt();
	const { outcome } = await e.userChoice;
	install.outcome = outcome;
}

/** "Not now", remembered in this browser. */
export function dismissInstall(): void {
	install.dismissed = true;
	install.sheetOpen = false;
	try {
		localStorage.setItem(DISMISS_KEY, '1');
	} catch {}
}
