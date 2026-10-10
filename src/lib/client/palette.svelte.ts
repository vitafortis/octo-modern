/**
 * Command palette state (⌘K / Ctrl+K): whether it's open, what the open printer page
 * offers, and recently used items.
 */

/** What an open printer page (/p/[id]) lets the palette do. */
export interface PrinterContext {
	printerId: string;
	openTab: (tab: string) => void;
	tabs: { id: string; label: string }[];
}

export const palette = $state<{ open: boolean; printer: PrinterContext | null }>({ open: false, printer: null });

/** Called by the printer page; returns the cleanup. */
export function registerPrinter(ctx: PrinterContext): () => void {
	palette.printer = ctx;
	return () => {
		if (palette.printer === ctx) palette.printer = null;
	};
}

const RECENT_KEY = 'ocm-palette-recent';

export const recents = $state<{ items: string[] }>({ items: [] });

export function loadRecents() {
	try {
		const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
		recents.items = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
	} catch {
		recents.items = [];
	}
}

export function noteRecent(key: string) {
	recents.items = [key, ...recents.items.filter((k) => k !== key)].slice(0, 20);
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(recents.items));
	} catch {}
}

/** ⌘K on macOS, Ctrl+K elsewhere. */
export function isPaletteShortcut(e: KeyboardEvent): boolean {
	if (e.key.toLowerCase() !== 'k' || e.shiftKey || e.altKey) return false;
	const mac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
	return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey || e.metaKey;
}
