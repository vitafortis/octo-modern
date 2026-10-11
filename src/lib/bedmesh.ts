/**
 * Bed meshes from the Bed Visualizer plugin (OctoPrint-BedLevelVisualizer): parsing what
 * the plugin stores and pushes, statistics, comparing two meshes, drift checks and the
 * colour scale. Shared by the server (src/lib/server/bedmesh.ts) and the Bed tab. Pure.
 *
 * What the plugin gives us:
 * - settings `plugins.bedlevelvisualizer`: `command` (the G-code it runs to probe, one line
 *   per command), `stored_mesh` (rows of Z offsets, often as strings), `stored_mesh_x` /
 *   `stored_mesh_y` (probe coordinates), `stored_mesh_z_height`, `mesh_timestamp`, `save_mesh`,
 *   `timeout` (s). The plugin's own web UI writes `stored_mesh*` after each probe run.
 * - push messages on the plugin socket (`plugin: bedlevelvisualizer`): `{ processing: true }`,
 *   `{ mesh, bed: { type, x_min, x_max, y_min, y_max, z_min, z_max } }`, `{ error }`,
 *   `{ timeout_override }`, `{ BLV }`.
 * - no REST command to start a probe run: its UI sends `@BEDLEVELVISUALIZER` followed by
 *   the `command` lines as G-code, and so do we.
 */

export const BLV_PLUGIN = 'bedlevelvisualizer';
/** The at-command that tells the plugin to collect the mesh the following G-code prints. */
export const BLV_AT_COMMAND = '@BEDLEVELVISUALIZER';

/** Largest grid we accept (the plugin handles up to firmware limits, typically ≤ 15×15). */
export const MAX_GRID = 100;
/** Offsets beyond this (mm) are probing garbage, not a bed. */
const MAX_ABS_Z = 50;

/** Z offsets in mm: `z[row][col]`, rows along Y (`ys`), columns along X (`xs`). `null` = not probed. */
export interface Mesh {
	z: (number | null)[][];
	xs: number[];
	ys: number[];
}

export interface MeshPoint {
	row: number;
	col: number;
	x: number;
	y: number;
	z: number;
}

export interface MeshStats {
	rows: number;
	cols: number;
	/** Probed points (numbers). */
	points: number;
	missing: number;
	min: number;
	max: number;
	mean: number;
	/** max − min, mm. */
	flatness: number;
	minAt: MeshPoint;
	maxAt: MeshPoint;
}

export type MeshSource = 'octoprint' | 'push' | 'update';

/** A stored mesh, without the grid (history lists). */
export interface MeshSummary {
	id: number;
	printerId: string;
	/** When octo·modern first saw this mesh. */
	createdAt: string;
	/** Last time OctoPrint still reported it. */
	lastSeenAt: string;
	/** The plugin's own `mesh_timestamp`, as it wrote it (a local date string). */
	pluginTimestamp: string | null;
	source: MeshSource;
	rows: number;
	cols: number;
	min: number;
	max: number;
	mean: number;
	flatness: number;
	/** Largest change from the reference mesh when it was stored, mm (null for the reference itself / none). */
	change: number | null;
	/** It broke a drift threshold. */
	drift: boolean;
}

export interface MeshSnapshot extends MeshSummary {
	mesh: Mesh;
	stats: MeshStats;
}

export interface DriftSettings {
	enabled: boolean;
	/** Alert when flatness (max − min) exceeds this, mm. */
	maxFlatness: number | null;
	/** Alert when any point moved more than this from the reference mesh, mm. */
	maxChange: number | null;
	/** The reference mesh; null = the oldest one kept. */
	referenceId: number | null;
}

export const DEFAULT_DRIFT: DriftSettings = { enabled: false, maxFlatness: 0.3, maxChange: 0.1, referenceId: null };

export type UpdatePhase = 'sending' | 'probing' | 'done' | 'error' | 'timeout';

/** A probe run started from octo·modern ("Update mesh"). */
export interface UpdateState {
	phase: UpdatePhase;
	startedAt: string;
	startedBy: string | null;
	endedAt: string | null;
	message: string | null;
	/** The mesh it produced. */
	meshId: number | null;
}

export interface PluginInfo {
	installed: boolean;
	/** The plugin's probe G-code, one command per entry (empty: not set up). */
	commands: string[];
	saveMesh: boolean;
	/** The plugin's own timeout for a probe run, seconds. */
	timeoutS: number;
	stored: Mesh | null;
	storedTimestamp: string | null;
	checkedAt: string;
	/** Why detection failed (OctoPrint unreachable…); `installed` is the last known value then. */
	error?: string | null;
}

// --- parsing -------------------------------------------------------------------

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** A Z value: numbers and numeric strings within ±50 mm; anything else ("nan", "", null, objects) is missing. */
export function toZ(v: unknown): number | null {
	let n: number;
	if (typeof v === 'number') n = v;
	else if (typeof v === 'string' && NUMERIC.test(v.trim())) n = Number(v.trim());
	else return null;
	return Number.isFinite(n) && Math.abs(n) <= MAX_ABS_Z ? n : null;
}

const finite = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : typeof v === 'string' && NUMERIC.test(v.trim()) ? Number(v.trim()) : NaN;
	return Number.isFinite(n) ? n : null;
};

/**
 * The grid from whatever the plugin stored: an array of rows (arrays of numbers or numeric
 * strings, or whitespace/comma-separated strings), possibly as a JSON string. Ragged rows are
 * padded with `null`; rows with nothing numeric at the edges are dropped. Null when there's
 * no number at all.
 */
export function parseGrid(raw: unknown): (number | null)[][] | null {
	if (typeof raw === 'string') {
		const s = raw.trim();
		if (!s) return null;
		try {
			raw = JSON.parse(s);
		} catch {
			raw = s.split(/\r?\n/);
		}
	}
	if (!Array.isArray(raw)) return null;
	let rows = raw.slice(0, MAX_GRID).map((r): (number | null)[] => {
		if (Array.isArray(r)) return r.slice(0, MAX_GRID).map(toZ);
		if (typeof r === 'string') return r.trim() ? r.trim().split(/[\s,;]+/).slice(0, MAX_GRID).map(toZ) : [];
		if (typeof r === 'number') return [toZ(r)];
		return [];
	});
	// A flat list of numbers is one row.
	if (raw.length && raw.every((r) => typeof r === 'number' || (typeof r === 'string' && NUMERIC.test(r.trim())))) rows = [raw.slice(0, MAX_GRID).map(toZ)];
	const hasValue = (r: (number | null)[]) => r.some((v) => v !== null);
	while (rows.length && !hasValue(rows[0])) rows.shift();
	while (rows.length && !hasValue(rows[rows.length - 1])) rows.pop();
	if (!rows.length) return null;
	const cols = Math.max(...rows.map((r) => r.length));
	return rows.map((r) => (r.length < cols ? [...r, ...Array<null>(cols - r.length).fill(null)] : r));
}

/** Evenly spaced positions from `min` to `max` (the plugin's own axis rule), or 0…n−1. */
export function evenAxis(n: number, min?: number | null, max?: number | null): number[] {
	if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || max === min) return Array.from({ length: n }, (_, i) => i);
	return Array.from({ length: n }, (_, i) => round(n === 1 ? min : min + (i / (n - 1)) * (max - min), 2));
}

/** An axis: the stored coordinates when they fit the grid (numbers, increasing or decreasing), else even spacing. */
export function parseAxis(raw: unknown, n: number, bounds?: { min?: number | null; max?: number | null }): number[] {
	if (Array.isArray(raw) && raw.length === n) {
		const v = raw.map(finite);
		if (v.every((x): x is number => x !== null)) return v;
	}
	return evenAxis(n, bounds?.min, bounds?.max);
}

/** A mesh from the plugin's grid and axes; null when there's nothing usable. */
export function parseMesh(input: { mesh: unknown; xs?: unknown; ys?: unknown; bed?: unknown }): Mesh | null {
	const z = parseGrid(input.mesh);
	if (!z) return null;
	const rows = z.length;
	const cols = z[0].length;
	const bed = (input.bed && typeof input.bed === 'object' ? input.bed : {}) as Record<string, unknown>;
	let xb = { min: finite(bed.x_min), max: finite(bed.x_max) };
	let yb = { min: finite(bed.y_min), max: finite(bed.y_max) };
	// Circular (delta) beds: the plugin centres the axes on the origin.
	if (bed.type === 'circular' && xb.min != null && xb.max != null && yb.min != null && yb.max != null) {
		xb = { min: xb.min - xb.max / 2, max: xb.max - xb.max / 2 };
		yb = { min: yb.min - yb.max / 2, max: yb.max - yb.max / 2 };
	}
	return { z, xs: parseAxis(input.xs, cols, xb), ys: parseAxis(input.ys, rows, yb) };
}

const lines = (v: unknown): string[] =>
	(typeof v === 'string' ? v.split(/\r?\n/) : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
		.map((l) => l.trim())
		.filter(Boolean);

/** The plugin's part of GET /api/settings (`settings.plugins`); `installed: false` when it isn't there. */
export function parsePluginSettings(plugins: unknown, now = new Date().toISOString()): PluginInfo {
	const p = plugins && typeof plugins === 'object' ? (plugins as Record<string, unknown>)[BLV_PLUGIN] : undefined;
	if (!p || typeof p !== 'object') return { installed: false, commands: [], saveMesh: false, timeoutS: 0, stored: null, storedTimestamp: null, checkedAt: now };
	const s = p as Record<string, unknown>;
	const timeout = finite(s.timeout);
	return {
		installed: true,
		commands: lines(s.command),
		saveMesh: s.save_mesh !== false,
		timeoutS: timeout && timeout > 0 ? timeout : 1800,
		stored: parseMesh({ mesh: s.stored_mesh, xs: s.stored_mesh_x, ys: s.stored_mesh_y }),
		storedTimestamp: typeof s.mesh_timestamp === 'string' && s.mesh_timestamp.trim() ? s.mesh_timestamp.trim() : null,
		checkedAt: now
	};
}

export type PluginMessage =
	| { kind: 'mesh'; mesh: Mesh; zMax: number | null }
	| { kind: 'processing' }
	| { kind: 'error'; message: string }
	| { kind: 'timeout'; seconds: number | null }
	| { kind: 'other' };

/** A push message from the plugin (`data` of `{ plugin: { plugin: 'bedlevelvisualizer', data } }`). */
export function parsePluginMessage(data: unknown): PluginMessage | null {
	if (!data || typeof data !== 'object') return null;
	const d = data as Record<string, unknown>;
	if ('mesh' in d) {
		const mesh = parseMesh({ mesh: d.mesh, bed: d.bed });
		const bed = (d.bed && typeof d.bed === 'object' ? d.bed : {}) as Record<string, unknown>;
		return mesh ? { kind: 'mesh', mesh, zMax: finite(bed.z_max) } : { kind: 'error', message: 'The plugin reported a mesh without any numbers' };
	}
	if (typeof d.error === 'string') return { kind: 'error', message: d.error };
	if (d.processing === true) return { kind: 'processing' };
	if ('timeout_override' in d) return { kind: 'timeout', seconds: finite(d.timeout_override) };
	return { kind: 'other' };
}

/** The G-code a probe run sends: the at-command, then the plugin's command lines. */
export function updateCommands(commands: string[]): string[] {
	return [BLV_AT_COMMAND, ...commands.filter((c) => c.trim() && c.trim().toUpperCase() !== BLV_AT_COMMAND)];
}

// --- statistics ------------------------------------------------------------------

export function round(n: number, digits = 4): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

/** min, max (and where), mean and flatness; null when no point is probed. */
export function meshStats(mesh: Mesh): MeshStats | null {
	let points = 0;
	let missing = 0;
	let sum = 0;
	let minAt: MeshPoint | null = null;
	let maxAt: MeshPoint | null = null;
	mesh.z.forEach((row, r) =>
		row.forEach((z, c) => {
			if (z === null) return void missing++;
			points++;
			sum += z;
			const at = { row: r, col: c, x: mesh.xs[c] ?? c, y: mesh.ys[r] ?? r, z };
			if (!minAt || z < minAt.z) minAt = at;
			if (!maxAt || z > maxAt.z) maxAt = at;
		})
	);
	if (!minAt || !maxAt) return null;
	const lo = minAt as MeshPoint;
	const hi = maxAt as MeshPoint;
	return {
		rows: mesh.z.length,
		cols: mesh.z[0]?.length ?? 0,
		points,
		missing,
		min: round(lo.z),
		max: round(hi.z),
		mean: round(sum / points),
		flatness: round(hi.z - lo.z),
		minAt: lo,
		maxAt: hi
	};
}

/** A stable key for "is this the same mesh?" (values to 0.1 µm, plus the axes). */
export function meshKey(mesh: Mesh): string {
	const z = mesh.z.map((r) => r.map((v) => (v === null ? 'n' : round(v, 4).toString())).join(',')).join(';');
	return `${z}|${mesh.xs.map((v) => round(v, 2)).join(',')}|${mesh.ys.map((v) => round(v, 2)).join(',')}`;
}

// --- comparing ----------------------------------------------------------------------

/** The value at normalised position (u along columns, v along rows, each 0…1), bilinear; skips missing corners. */
export function sampleAt(mesh: Mesh, u: number, v: number): number | null {
	const rows = mesh.z.length;
	const cols = mesh.z[0]?.length ?? 0;
	if (!rows || !cols) return null;
	const fx = Math.min(Math.max(u, 0), 1) * (cols - 1);
	const fy = Math.min(Math.max(v, 0), 1) * (rows - 1);
	const c0 = Math.floor(fx);
	const r0 = Math.floor(fy);
	const c1 = Math.min(c0 + 1, cols - 1);
	const r1 = Math.min(r0 + 1, rows - 1);
	const tx = fx - c0;
	const ty = fy - r0;
	const corners: [number | null, number][] = [
		[mesh.z[r0][c0], (1 - tx) * (1 - ty)],
		[mesh.z[r0][c1], tx * (1 - ty)],
		[mesh.z[r1][c0], (1 - tx) * ty],
		[mesh.z[r1][c1], tx * ty]
	];
	let w = 0;
	let s = 0;
	for (const [z, wt] of corners) {
		if (z === null || wt <= 0) continue;
		s += z * wt;
		w += wt;
	}
	// Exactly on a missing point: missing.
	if (w === 0) return null;
	const exact = corners.find(([, wt]) => wt === 1);
	if (exact && exact[0] === null) return null;
	return s / w;
}

const normalised = (axis: number[], i: number) => {
	const n = axis.length;
	if (n <= 1) return 0;
	const lo = axis[0];
	const hi = axis[n - 1];
	return hi === lo ? i / (n - 1) : (axis[i] - lo) / (hi - lo);
};

/**
 * `to − from` on `to`'s grid. Meshes of a different size (another probe count) are resampled
 * over the bed's extent, so a 5×5 and a 7×7 still compare.
 */
export function diffMesh(from: Mesh, to: Mesh): Mesh {
	const same = from.z.length === to.z.length && from.z[0]?.length === to.z[0]?.length;
	const z = to.z.map((row, r) =>
		row.map((b, c) => {
			if (b === null) return null;
			const a = same ? from.z[r][c] : sampleAt(from, normalised(to.xs, c), normalised(to.ys, r));
			return a === null ? null : round(b - a);
		})
	);
	return { z, xs: [...to.xs], ys: [...to.ys] };
}

/** The largest |value| (e.g. of a difference map); null when empty. */
export function maxAbs(mesh: Mesh): number | null {
	let m: number | null = null;
	for (const row of mesh.z) for (const v of row) if (v !== null && (m === null || Math.abs(v) > m)) m = Math.abs(v);
	return m === null ? null : round(m);
}

export interface DriftCheck {
	flatness: number;
	/** Largest change from the reference, mm (null without a reference). */
	change: number | null;
	/** What broke a threshold, as sentences (empty: fine). */
	breaches: string[];
}

const mm = (n: number) => `${n.toFixed(3)} mm`;

/** Checks a mesh against the thresholds; the reference is optional. Thresholds apply even when alerts are off (`breaches` says what would alert). */
export function checkDrift(mesh: Mesh, reference: Mesh | null, s: Pick<DriftSettings, 'maxFlatness' | 'maxChange'>): DriftCheck | null {
	const stats = meshStats(mesh);
	if (!stats) return null;
	const change = reference ? maxAbs(diffMesh(reference, mesh)) : null;
	const breaches: string[] = [];
	if (s.maxFlatness != null && stats.flatness > s.maxFlatness) breaches.push(`Flatness ${mm(stats.flatness)} is over the ${mm(s.maxFlatness)} limit`);
	if (s.maxChange != null && change != null && change > s.maxChange) breaches.push(`A point moved ${mm(change)} from the reference mesh (limit ${mm(s.maxChange)})`);
	return { flatness: stats.flatness, change, breaches };
}

/** Validates drift settings from a form; throws with a message for the user. */
export function parseDriftSettings(b: Record<string, unknown>, current: DriftSettings = DEFAULT_DRIFT): DriftSettings {
	const out = { ...current };
	if (b.enabled !== undefined) out.enabled = b.enabled === true;
	for (const key of ['maxFlatness', 'maxChange'] as const) {
		if (b[key] === undefined) continue;
		if (b[key] === null || b[key] === '') {
			out[key] = null;
			continue;
		}
		const n = Number(b[key]);
		if (!Number.isFinite(n) || n <= 0 || n > 10) throw new Error(`${key === 'maxFlatness' ? 'The flatness limit' : 'The change limit'} must be a number of mm above 0 and at most 10`);
		out[key] = round(n, 3);
	}
	if (b.referenceId !== undefined) {
		const n = b.referenceId === null ? null : Number(b.referenceId);
		if (n !== null && (!Number.isInteger(n) || n <= 0)) throw new Error('"referenceId" must be a mesh id or null');
		out.referenceId = n;
	}
	if (out.enabled && out.maxFlatness == null && out.maxChange == null) throw new Error('Set a flatness or a change limit to turn drift alerts on');
	return out;
}

// --- colour --------------------------------------------------------------------------

/** `oklch(L% C H)` / `oklch(L C H)` → [L 0–1, C, H]; null for anything else. */
export function parseOklch(css: string): [number, number, number] | null {
	const m = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i.exec(css.trim());
	if (!m) return null;
	const l = Number(m[1]) / (m[2] ? 100 : 1);
	return [l, Number(m[3]), Number(m[4])];
}

/** Interpolates OKLCH colours (shortest way round the hue circle). */
export function mixOklch(a: [number, number, number], b: [number, number, number], t: number): string {
	let dh = b[2] - a[2];
	if (dh > 180) dh -= 360;
	if (dh < -180) dh += 360;
	const l = a[0] + (b[0] - a[0]) * t;
	const c = a[1] + (b[1] - a[1]) * t;
	const h = (a[2] + dh * t + 360) % 360;
	return `oklch(${(l * 100).toFixed(1)}% ${c.toFixed(3)} ${h.toFixed(1)})`;
}

/** A diverging scale low → mid → high: maps a value in [−range, +range] (around `center`) to a colour. */
export function divergingColor(value: number, center: number, range: number, stops: { low: [number, number, number]; mid: [number, number, number]; high: [number, number, number] }): string {
	const t = range > 0 ? Math.max(-1, Math.min(1, (value - center) / range)) : 0;
	return t < 0 ? mixOklch(stops.mid, stops.low, -t) : mixOklch(stops.mid, stops.high, t);
}

/** Text that stays readable on a cell: dark on light cells, light on dark ones. */
export function inkFor(color: string): string {
	const c = parseOklch(color);
	return c && c[0] > 0.62 ? 'oklch(20% 0.01 292)' : 'oklch(98% 0 0)';
}

/** "+0.123" / "−0.045" (true minus sign), mm values for the grid and stats. */
export function fmtZ(v: number | null, digits = 3, signed = true): string {
	if (v === null || !Number.isFinite(v)) return '—';
	const s = Math.abs(v).toFixed(digits);
	if (Number(s) === 0) return (0).toFixed(digits);
	return `${v < 0 ? '−' : signed ? '+' : ''}${s}`;
}
