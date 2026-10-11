/**
 * The camera wall's options, kept in the URL so a layout (or a kiosk setup for a wall
 * tablet) can be bookmarked: /cameras?kiosk=1&layout=2&mode=snapshot&every=5&rotate=20
 * Pure: shared by the page and the tests.
 */

export type WallLayout = 'auto' | 1 | 2 | 3 | 4;
export type WallMode = 'auto' | 'live' | 'snapshot';

export interface WallOptions {
	/** Columns on screens wider than a phone (`auto`: as many as fit). Phones always get one. */
	layout: WallLayout;
	/** Hide the app's chrome, hide the cursor when idle, keep the screen awake. */
	kiosk: boolean;
	/** `live` MJPEG streams, `snapshot` refreshes, or `auto` (live for a few cameras, snapshots for many). */
	mode: WallMode;
	/** Snapshot refresh interval, seconds. */
	every: number;
	/** Kiosk: show one camera at a time, switching every N seconds (0 = off, show the grid). */
	rotate: number;
	/** Only these printers (null: all the user can see). */
	printers: string[] | null;
	/** Crop to fill the tile instead of showing the whole picture. */
	fill: boolean;
}

export const DEFAULTS: WallOptions = { layout: 'auto', kiosk: false, mode: 'auto', every: 10, rotate: 0, printers: null, fill: false };

/**
 * Live streams with `auto` mode up to this many tiles. Each MJPEG stream holds an HTTP
 * connection open, and browsers allow only six per host over HTTP/1.1; beyond a few
 * cameras, snapshots also save a lot of bandwidth.
 */
export const LIVE_LIMIT = 4;

export const EVERY_CHOICES = [2, 5, 10, 30, 60];
export const ROTATE_CHOICES = [0, 10, 20, 30, 60];

const clampInt = (raw: string | null, min: number, max: number, fallback: number) => {
	const n = Number(raw);
	return raw !== null && raw.trim() !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

const truthy = (v: string | null) => v !== null && !/^(0|false|no|off)$/i.test(v);

export function parseWallParams(q: Pick<URLSearchParams, 'get'>): WallOptions {
	const l = q.get('layout');
	const layout: WallLayout = l === '1' || l === '2' || l === '3' || l === '4' ? (Number(l) as WallLayout) : 'auto';
	const m = q.get('mode');
	const mode: WallMode = m === 'live' || m === 'snapshot' ? m : 'auto';
	const p = q.get('printers');
	const printers = p
		? p
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
				.slice(0, 100)
		: null;
	return {
		layout,
		kiosk: truthy(q.get('kiosk')),
		mode,
		every: clampInt(q.get('every'), 1, 600, DEFAULTS.every),
		rotate: clampInt(q.get('rotate'), 0, 3600, 0),
		printers: printers?.length ? printers : null,
		fill: truthy(q.get('fill'))
	};
}

/** The query string for options (defaults left out), without the leading `?`. */
export function wallQuery(o: WallOptions): string {
	const q = new URLSearchParams();
	if (o.kiosk) q.set('kiosk', '1');
	if (o.layout !== 'auto') q.set('layout', String(o.layout));
	if (o.mode !== 'auto') q.set('mode', o.mode);
	if (o.every !== DEFAULTS.every) q.set('every', String(o.every));
	if (o.rotate) q.set('rotate', String(o.rotate));
	if (o.printers?.length) q.set('printers', o.printers.join(','));
	if (o.fill) q.set('fill', '1');
	return q.toString();
}

/** Whether tiles stream live, given the mode and how many tiles are showing at once. */
export function streamsLive(mode: WallMode, tilesShown: number): boolean {
	if (mode === 'live') return true;
	if (mode === 'snapshot') return false;
	return tilesShown <= LIVE_LIMIT;
}

/**
 * Columns and rows for a kiosk grid filling the screen: the layout's columns, or a
 * near-square grid (wider than tall on a landscape screen, taller on a portrait one).
 */
export function kioskGrid(count: number, layout: WallLayout, landscape = true): { cols: number; rows: number } {
	if (count <= 0) return { cols: 1, rows: 1 };
	const root = Math.sqrt(count);
	let cols = layout === 'auto' ? (landscape ? Math.ceil(root) : Math.floor(root)) : Math.min(layout, count);
	cols = Math.max(1, Math.min(cols, count));
	return { cols, rows: Math.ceil(count / cols) };
}
