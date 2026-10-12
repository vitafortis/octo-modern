/**
 * The printer page's sections and their sub-views, as plain data (no components), so the
 * URL rules are shared by the page, the command palette, server-side links and tests.
 *
 * Six tabs: Dashboard | Files | Control | Camera | Jobs | Care. Some have sub-views kept
 * in `?view=<id>` next to `?tab=<id>`; the first tab and a tab's first view are the
 * defaults and stay out of the URL. The twelve tabs before them (`?tab=preview`,
 * `?tab=terminal`, `?tab=bed`, …) still work: `resolveTab` maps them to the new place.
 */

export type TabId = 'dashboard' | 'files' | 'control' | 'camera' | 'jobs' | 'care';

export interface ViewMeta {
	id: string;
	label: string;
	/** Only shown when the printer has this optional feature (e.g. an OctoPrint plugin). */
	requires?: 'bedmesh';
	/** Shown as a segment of the tab's switcher; false for views opened from inside the tab (the toolpath preview, the full-height terminal). */
	segment?: boolean;
	/** Extra words the command palette matches. */
	keywords?: string;
}

export interface TabMeta {
	id: TabId;
	label: string;
	views?: ViewMeta[];
	keywords?: string;
}

export const TAB_META: TabMeta[] = [
	{ id: 'dashboard', label: 'Dashboard', keywords: 'status overview job temperatures' },
	{ id: 'files', label: 'Files', keywords: 'gcode upload print', views: [{ id: 'list', label: 'Files' }, { id: 'preview', label: 'Toolpath preview', segment: false, keywords: 'gcode viewer 3d layers' }] },
	{ id: 'control', label: 'Control', keywords: 'jog move home fan extrude', views: [{ id: 'controls', label: 'Control' }, { id: 'terminal', label: 'Terminal', segment: false, keywords: 'console gcode send' }] },
	{
		id: 'camera',
		label: 'Camera',
		keywords: 'webcam stream',
		views: [
			{ id: 'live', label: 'Live', keywords: 'webcam stream' },
			{ id: 'timelapse', label: 'Timelapses', keywords: 'timelapse video' },
			{ id: 'detection', label: 'Failure detection', keywords: 'spaghetti ai obico detect' }
		]
	},
	{
		id: 'jobs',
		label: 'Jobs',
		keywords: 'prints',
		views: [
			{ id: 'history', label: 'History', keywords: 'past prints' },
			{ id: 'queue', label: 'Queue', keywords: 'print queue next' }
		]
	},
	{
		id: 'care',
		label: 'Care',
		keywords: 'upkeep',
		views: [
			{ id: 'maintenance', label: 'Maintenance', keywords: 'nozzle belts reminders' },
			{ id: 'bed', label: 'Bed mesh', requires: 'bedmesh', keywords: 'bed visualizer leveling mesh' }
		]
	}
];

/** The twelve tabs of old, as tab + view. */
export const LEGACY_TABS: Record<string, { tab: TabId; view?: string }> = {
	preview: { tab: 'files', view: 'preview' },
	terminal: { tab: 'control', view: 'terminal' },
	webcam: { tab: 'camera', view: 'live' },
	timelapse: { tab: 'camera', view: 'timelapse' },
	detection: { tab: 'camera', view: 'detection' },
	history: { tab: 'jobs', view: 'history' },
	queue: { tab: 'jobs', view: 'queue' },
	maintenance: { tab: 'care', view: 'maintenance' },
	bed: { tab: 'care', view: 'bed' }
};

export type Features = Partial<Record<NonNullable<ViewMeta['requires']>, boolean>> | undefined;

/** The tabs and views this printer has: views missing their plugin or hidden for the printer kind are dropped. */
export function tabsFor(features: Features, hidden: Set<string> = new Set()): TabMeta[] {
	return TAB_META.map((t) => (t.views ? { ...t, views: t.views.filter((v) => (!v.requires || features?.[v.requires]) && !hidden.has(v.id)) } : t));
}

/**
 * Where `?tab=` and `?view=` point: the tab and view to show, and whether the URL used
 * an old tab id (the page then rewrites it). Unknown or unavailable ids fall back to the
 * first tab / the tab's first view.
 */
export function resolveTab(tabs: TabMeta[], tabParam: string | null, viewParam: string | null): { tab: TabMeta; view: string | null; legacy: boolean } {
	let tabId = tabParam;
	let viewId = viewParam;
	const old = tabParam ? LEGACY_TABS[tabParam] : undefined;
	if (old) {
		tabId = old.tab;
		viewId = old.view ?? null;
	}
	const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];
	const views = tab.views ?? [];
	const view = views.find((v) => v.id === viewId)?.id ?? views[0]?.id ?? null;
	return { tab, view, legacy: !!old };
}

/**
 * The query string for a tab and view (keeping `keep` params, such as preview's `file`
 * and `v`). Defaults are left out: `''` for the dashboard.
 */
export function tabSearch(tabs: TabMeta[], tab: string, view?: string | null, keep: Record<string, string | null | undefined> = {}): string {
	const q = new URLSearchParams();
	const t = tabs.find((x) => x.id === tab) ?? tabs[0];
	if (t.id !== tabs[0].id) q.set('tab', t.id);
	if (view && t.views?.length && view !== t.views[0].id) q.set('view', view);
	for (const [k, v] of Object.entries(keep)) if (v != null && v !== '') q.set(k, v);
	const s = q.toString();
	return s ? `?${s}` : '';
}

/**
 * The canonical URL for an old link (`?tab=preview&file=x` → `?tab=files&view=preview&file=x`),
 * or null when the URL is already current.
 */
export function canonicalSearch(tabs: TabMeta[], params: Pick<URLSearchParams, 'get' | 'entries'>): string | null {
	const r = resolveTab(tabs, params.get('tab'), params.get('view'));
	if (!r.legacy) return null;
	const keep: Record<string, string> = {};
	for (const [k, v] of params.entries()) if (k !== 'tab' && k !== 'view') keep[k] = v;
	return tabSearch(tabs, r.tab.id, r.view, keep);
}

/** A link to a printer's tab, for notifications and other pages (no feature knowledge: the page falls back if a view is missing). */
export function printerTabPath(printerId: string, tab: TabId, view?: string): string {
	return `/p/${encodeURIComponent(printerId)}${tabSearch(TAB_META, tab, view)}`;
}

/** Command palette entries: each tab, and each view a tab has beyond its default. */
export function paletteEntries(tabs: TabMeta[]): { id: string; tab: TabId; view: string | null; label: string; keywords: string }[] {
	const out: { id: string; tab: TabId; view: string | null; label: string; keywords: string }[] = [];
	for (const t of tabs) {
		out.push({ id: t.id, tab: t.id, view: null, label: t.label, keywords: t.keywords ?? '' });
		for (const v of (t.views ?? []).slice(1)) out.push({ id: `${t.id}/${v.id}`, tab: t.id, view: v.id, label: `${t.label} › ${v.label}`, keywords: v.keywords ?? '' });
	}
	return out;
}
