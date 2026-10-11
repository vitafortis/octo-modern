/**
 * Spools (Spoolman), print costs and maintenance reminders: types shared by the server
 * and the browser, and the arithmetic behind them. Pure.
 */

// --- filament geometry ---------------------------------------------------------------

/** Grams of `mm` of filament of `diameter` mm at `density` g/cm³. */
export function gramsFromMm(mm: number, density: number, diameter: number): number {
	const r = diameter / 2;
	return ((mm * Math.PI * r * r) / 1000) * density;
}

/** Millimetres of filament in `grams` (the inverse of gramsFromMm). */
export function mmFromGrams(grams: number, density: number, diameter: number): number {
	const r = diameter / 2;
	return (grams / density) * 1000 / (Math.PI * r * r);
}

// --- Spoolman -------------------------------------------------------------------------

/** A spool as octo·modern shows it (from Spoolman's `Spool`, with its filament and vendor folded in). */
export interface SpoolSummary {
	id: number;
	/** The filament's name, e.g. "Galaxy Black". */
	name: string;
	vendor: string | null;
	material: string | null;
	/** `#rrggbb`, or null. */
	color: string | null;
	/** Several colours for multi-colour filament (`#rrggbb` each). */
	colors: string[] | null;
	/** Grams. */
	remainingWeight: number | null;
	initialWeight: number | null;
	usedWeight: number | null;
	/** Millimetres; computed from the weight when Spoolman doesn't say. */
	remainingLength: number | null;
	/** g/cm³ and mm, from the filament. */
	density: number;
	diameter: number;
	/** Price per kg from the spool's price (or the filament's), in Spoolman's currency. */
	pricePerKg: number | null;
	location: string | null;
	lotNr: string | null;
	comment: string | null;
	archived: boolean;
	lastUsed: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const hex = (v: unknown) => {
	const s = str(v)?.replace(/^#/, '');
	return s && /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s) ? `#${s.slice(0, 6).toLowerCase()}` : null;
};

/** Spoolman's `Spool` (GET /api/v1/spool[/{id}]) → SpoolSummary; null for anything without an id. */
export function parseSpool(raw: unknown): SpoolSummary | null {
	if (!isObj(raw) || num(raw.id) == null) return null;
	const f = isObj(raw.filament) ? raw.filament : {};
	const v = isObj(f.vendor) ? f.vendor : {};
	const density = num(f.density) && (f.density as number) > 0 ? (f.density as number) : 1.24;
	const diameter = num(f.diameter) && (f.diameter as number) > 0 ? (f.diameter as number) : 1.75;
	const initialWeight = num(raw.initial_weight) ?? num(f.weight);
	const usedWeight = num(raw.used_weight);
	const remainingWeight = num(raw.remaining_weight) ?? (initialWeight != null && usedWeight != null ? Math.max(0, initialWeight - usedWeight) : null);
	const remainingLength = num(raw.remaining_length) ?? (remainingWeight != null ? mmFromGrams(remainingWeight, density, diameter) : null);
	const spoolPrice = num(raw.price);
	const filamentPrice = num(f.price);
	const filamentWeight = num(f.weight);
	const pricePerKg =
		spoolPrice != null && initialWeight ? (spoolPrice / initialWeight) * 1000 : filamentPrice != null && filamentWeight ? (filamentPrice / filamentWeight) * 1000 : null;
	const multi = str(f.multi_color_hexes)
		?.split(',')
		.map(hex)
		.filter((c): c is string => !!c);
	return {
		id: raw.id as number,
		name: str(f.name) ?? `Spool #${raw.id}`,
		vendor: str(v.name),
		material: str(f.material),
		color: hex(f.color_hex) ?? multi?.[0] ?? null,
		colors: multi && multi.length > 1 ? multi : null,
		remainingWeight,
		initialWeight,
		usedWeight,
		remainingLength,
		density,
		diameter,
		pricePerKg: pricePerKg != null ? Math.round(pricePerKg * 100) / 100 : null,
		location: str(raw.location),
		lotNr: str(raw.lot_nr),
		comment: str(raw.comment),
		archived: raw.archived === true,
		lastUsed: str(raw.last_used)
	};
}

/** Spoolman connection as the browser sees it (the auth header comes back as a hint only). */
export interface SpoolmanSettings {
	url: string | null;
	/** Name of the extra header sent with every request (e.g. Authorization), its value sealed. */
	authHeader: string | null;
	hasAuthValue: boolean;
	/** Below this many grams a spool counts as low (`spool.low` notification, warning on the dashboard). */
	lowThresholdG: number;
	/** Report filament use while printing (every metre or so), not only at the end. */
	progressive: boolean;
}

/** One tool's active spool on a printer. */
export interface SpoolAssignment {
	tool: number;
	spoolId: number;
	spool: SpoolSummary | null;
	assignedAt: string;
	assignedBy: string | null;
}

export interface PrinterSpools {
	configured: boolean;
	/** Tools (extruders) the printer has, from its live temperatures (at least 1). */
	tools: number;
	assignments: SpoolAssignment[];
	lowThresholdG: number;
	/** Spoolman couldn't be reached (assignments are still listed, without details). */
	error: string | null;
}

/** Remaining filament in words: `412 g · 138 m`. */
export function remainingLabel(s: Pick<SpoolSummary, 'remainingWeight' | 'remainingLength'>): string {
	const parts: string[] = [];
	if (s.remainingWeight != null) parts.push(`${Math.round(s.remainingWeight)} g`);
	if (s.remainingLength != null) parts.push(`${(s.remainingLength / 1000).toFixed(s.remainingLength < 10_000 ? 1 : 0)} m`);
	return parts.join(' · ') || 'unknown';
}

/** 0–1 of the spool left, when the initial weight is known. */
export function remainingFraction(s: Pick<SpoolSummary, 'remainingWeight' | 'initialWeight'>): number | null {
	if (s.remainingWeight == null || !s.initialWeight) return null;
	return Math.max(0, Math.min(1, s.remainingWeight / s.initialWeight));
}

/** What a print needs, per tool (mm), and optionally its weight (slicer metadata). */
export interface FilamentNeed {
	perTool: Record<number, number>;
	totalG?: number | null;
}

export interface Shortfall {
	tool: number;
	spool: SpoolSummary;
	needMm: number;
	needG: number;
	haveMm: number;
	haveG: number | null;
}

/**
 * Tools whose active spool has less than the print needs. A tool without a spool, or
 * a spool whose remaining amount Spoolman doesn't know, is never a shortfall.
 */
export function findShortfalls(need: FilamentNeed, spools: Map<number, SpoolSummary>): Shortfall[] {
	const out: Shortfall[] = [];
	const tools = Object.keys(need.perTool).map(Number);
	for (const tool of tools) {
		const spool = spools.get(tool);
		const mm = need.perTool[tool];
		if (!spool || !(mm > 0) || spool.remainingLength == null) continue;
		// The slicer's weight is more exact than our conversion, when it's for this one tool.
		const g = tools.length === 1 && need.totalG ? need.totalG : gramsFromMm(mm, spool.density, spool.diameter);
		const short = tools.length === 1 && need.totalG && spool.remainingWeight != null ? g > spool.remainingWeight : mm > spool.remainingLength;
		if (short) out.push({ tool, spool, needMm: mm, needG: g, haveMm: spool.remainingLength, haveG: spool.remainingWeight });
	}
	return out;
}

/** The 409 message for shortfalls. */
export function shortfallMessage(list: Shortfall[], multiTool: boolean): string {
	const m = (mm: number) => `${(mm / 1000).toFixed(1)} m`;
	const lines = list.map((s) => {
		const which = `${multiTool ? `Tool ${s.tool}: ` : ''}${s.spool.name}${s.spool.material ? ` (${s.spool.material})` : ''}`;
		const have = s.haveG != null ? `${Math.round(s.haveG)} g / ${m(s.haveMm)}` : m(s.haveMm);
		return `${which} has ${have} left; this print needs about ${Math.round(s.needG)} g / ${m(s.needMm)}.`;
	});
	return `Not enough filament. ${lines.join(' ')} Start anyway?`;
}

// --- costs ----------------------------------------------------------------------------

export interface MaterialCost {
	name: string;
	/** Per kg, in the settings' currency; null when unknown. */
	pricePerKg: number | null;
	/** g/cm³. */
	density: number;
}

export interface CostSettings {
	/** ISO 4217 code, e.g. EUR. */
	currency: string;
	electricityPerKwh: number | null;
	/** Average draw while printing, W, for printers without their own. */
	defaultPowerW: number | null;
	printerPowerW: Record<string, number>;
	materials: MaterialCost[];
	/** Material assumed when a print's spool isn't known. */
	defaultMaterial: string;
	/** Filament diameter (mm) assumed when a print's spool isn't known. */
	diameter: number;
	/** Use the spool's price from Spoolman when it has one. */
	useSpoolmanPrices: boolean;
}

export const DEFAULT_MATERIALS: MaterialCost[] = [
	{ name: 'PLA', pricePerKg: 20, density: 1.24 },
	{ name: 'PETG', pricePerKg: 22, density: 1.27 },
	{ name: 'ABS', pricePerKg: 22, density: 1.04 },
	{ name: 'ASA', pricePerKg: 26, density: 1.07 },
	{ name: 'TPU', pricePerKg: 32, density: 1.21 },
	{ name: 'PA', pricePerKg: 45, density: 1.14 },
	{ name: 'PC', pricePerKg: 38, density: 1.2 }
];

export const DEFAULT_COSTS: CostSettings = {
	currency: 'EUR',
	electricityPerKwh: null,
	defaultPowerW: null,
	printerPowerW: {},
	materials: DEFAULT_MATERIALS,
	defaultMaterial: 'PLA',
	diameter: 1.75,
	useSpoolmanPrices: true
};

/** Filament of one tool for costing: its length, and the spool it came from when known. */
export interface ToolUse {
	mm: number;
	spool?: Pick<SpoolSummary, 'material' | 'density' | 'diameter' | 'pricePerKg'> | null;
}

export interface PrintCost {
	filamentG: number | null;
	costFilament: number | null;
	costEnergy: number | null;
	/** The material (of the first tool), for the history. */
	material: string | null;
	/** Price per kg used (of the first tool). */
	pricePerKg: number | null;
	/** `spool`: Spoolman's price; `settings`: the material price list. */
	source: 'spool' | 'settings' | null;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function materialOf(settings: CostSettings, name: string | null | undefined): MaterialCost {
	const n = (name ?? '').trim().toLowerCase();
	return (
		settings.materials.find((m) => m.name.toLowerCase() === n) ??
		settings.materials.find((m) => m.name.toLowerCase() === settings.defaultMaterial.toLowerCase()) ??
		settings.materials[0] ?? { name: settings.defaultMaterial, pricePerKg: null, density: 1.24 }
	);
}

/** What a print cost: filament (per tool, by spool or material price) plus electricity (duration × draw). */
export function computeCost(input: { tools: ToolUse[]; durationS: number | null; powerW: number | null }, settings: CostSettings): PrintCost {
	let grams: number | null = null;
	let costFilament: number | null = null;
	let material: string | null = null;
	let pricePerKg: number | null = null;
	let source: PrintCost['source'] = null;
	for (const [i, t] of input.tools.entries()) {
		if (!(t.mm >= 0)) continue;
		const mat = materialOf(settings, t.spool?.material);
		const density = t.spool?.density ?? mat.density;
		const diameter = t.spool?.diameter ?? settings.diameter;
		const g = gramsFromMm(t.mm, density, diameter);
		const fromSpool = settings.useSpoolmanPrices && t.spool?.pricePerKg != null;
		const price = fromSpool ? t.spool!.pricePerKg! : mat.pricePerKg;
		grams = (grams ?? 0) + g;
		if (price != null) costFilament = (costFilament ?? 0) + (g / 1000) * price;
		if (i === 0) {
			material = t.spool?.material ?? mat.name;
			pricePerKg = price;
			source = price == null ? null : fromSpool ? 'spool' : 'settings';
		}
	}
	const kwh = input.durationS != null && input.powerW != null && input.durationS > 0 ? (input.durationS / 3600) * (input.powerW / 1000) : null;
	const costEnergy = kwh != null && settings.electricityPerKwh != null ? kwh * settings.electricityPerKwh : null;
	return {
		filamentG: grams != null ? round(grams, 2) : null,
		costFilament: costFilament != null ? round(costFilament) : null,
		costEnergy: costEnergy != null ? round(costEnergy) : null,
		material,
		pricePerKg,
		source
	};
}

export function powerOf(settings: CostSettings, printerId: string): number | null {
	return settings.printerPowerW[printerId] ?? settings.defaultPowerW;
}

/** `€1.23` in the given currency (falls back to `1.23 XYZ` for unknown codes). */
export function formatMoney(n: number | null | undefined, currency: string): string {
	if (n == null) return '—';
	try {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: n !== 0 && Math.abs(n) < 0.1 ? 3 : 2 }).format(n);
	} catch {
		return `${n.toFixed(2)} ${currency}`;
	}
}

// --- maintenance --------------------------------------------------------------------------

/** What a task's interval counts: print hours, filament (kg) or calendar days. */
export type MaintenanceMetric = 'hours' | 'filament' | 'days';
export const METRICS: MaintenanceMetric[] = ['hours', 'filament', 'days'];
export const METRIC_UNIT: Record<MaintenanceMetric, string> = { hours: 'print hours', filament: 'kg of filament', days: 'days' };
export const METRIC_SHORT: Record<MaintenanceMetric, string> = { hours: 'h', filament: 'kg', days: 'd' };

/** `ok`; `due` (90% of the interval used: due soon); `overdue` (past it). */
export type MaintenanceStatus = 'ok' | 'due' | 'overdue';

export interface MaintenanceTask {
	id: string;
	printerId: string;
	name: string;
	metric: MaintenanceMetric;
	interval: number;
	notes: string | null;
	createdAt: string;
	/** When it was last marked done (null: never; counting from `createdAt`). */
	lastDoneAt: string | null;
	lastDoneBy: string | null;
	/** Used since then, in the metric's unit. */
	used: number;
	/** used / interval. */
	progress: number;
	status: MaintenanceStatus;
}

export interface MaintenanceLogEntry {
	id: number;
	taskId: string;
	printerId: string;
	printerName: string;
	taskName: string;
	metric: MaintenanceMetric;
	interval: number;
	/** Used at the time it was done, in the metric's unit. */
	used: number;
	doneAt: string;
	doneBy: string | null;
	notes: string | null;
}

export interface MaintenanceTemplate {
	key: string;
	name: string;
	metric: MaintenanceMetric;
	interval: number;
	notes: string;
}

/** Offered when a printer has no tasks yet. */
export const DEFAULT_TASKS: MaintenanceTemplate[] = [
	{ key: 'nozzle', name: 'Change nozzle', metric: 'hours', interval: 500, notes: 'Brass wears fastest with abrasive filaments; check for a worn tip and under-extrusion.' },
	{ key: 'belts', name: 'Check belt tension', metric: 'hours', interval: 200, notes: 'Pluck X/Y belts; re-tension and check the idlers.' },
	{ key: 'lube', name: 'Lubricate rods and rails', metric: 'hours', interval: 150, notes: 'Clean old grease off the rails and lead screws first.' },
	{ key: 'bed', name: 'Clean the bed', metric: 'days', interval: 7, notes: 'Dish soap and hot water, or IPA for a quick wipe.' },
	{ key: 'esteps', name: 'Check e-steps', metric: 'filament', interval: 5, notes: 'Mark 120 mm, extrude 100 mm, measure what’s left.' }
];

export function maintenanceStatus(used: number, interval: number): MaintenanceStatus {
	if (!(interval > 0)) return 'ok';
	const p = used / interval;
	return p >= 1 ? 'overdue' : p >= 0.9 ? 'due' : 'ok';
}

/** `12.5 / 200 h`. */
export function usageLabel(t: Pick<MaintenanceTask, 'metric' | 'used' | 'interval'>): string {
	const d = t.metric === 'filament' ? 2 : t.metric === 'hours' ? 1 : 0;
	const u = t.used.toFixed(t.used < 10 ? d : 0);
	return `${u} / ${t.interval} ${METRIC_SHORT[t.metric]}`;
}
