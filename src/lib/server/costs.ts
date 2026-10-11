/**
 * Cost per print: the settings (electricity price, power draw per printer, filament
 * price and density per material), costing a finished print, and filling in the cost
 * of history entries recorded before (or without) it.
 */
import { getKv, setKv, sqlite } from './store.ts';
import { updatePrint } from './history/store.ts';
import { computeCost, DEFAULT_COSTS, gramsFromMm, materialOf, powerOf, type CostSettings, type PrintCost, type ToolUse } from '#lib/spools.ts';
import type { PrintRecord } from '#lib/history.ts';

const KEY = 'costs:settings';

export function costSettings(): CostSettings {
	const s = getKv<Partial<CostSettings>>(KEY, {});
	return { ...DEFAULT_COSTS, ...s, printerPowerW: { ...(s.printerPowerW ?? {}) }, materials: s.materials?.length ? s.materials : DEFAULT_COSTS.materials };
}

const optNum = (v: unknown, label: string, max: number): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label} must be a number from 0 to ${max}`);
	return n;
};

/** Validates and saves; throws with a message for the user. */
export function saveCostSettings(b: Record<string, unknown>, printerIds: string[]): CostSettings {
	const currency = typeof b.currency === 'string' ? b.currency.trim().toUpperCase() : 'EUR';
	if (!/^[A-Z]{3}$/.test(currency)) throw new Error('The currency must be a three-letter code like EUR or USD');
	const printerPowerW: Record<string, number> = {};
	if (b.printerPowerW && typeof b.printerPowerW === 'object') {
		for (const [id, w] of Object.entries(b.printerPowerW as Record<string, unknown>)) {
			const n = optNum(w, 'Power draw', 10_000);
			if (n != null && printerIds.includes(id)) printerPowerW[id] = n;
		}
	}
	const rawMaterials = Array.isArray(b.materials) ? b.materials : [];
	if (rawMaterials.length > 40) throw new Error('At most 40 materials');
	const seen = new Set<string>();
	const materials = rawMaterials.map((m, i) => {
		const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
		const name = typeof o.name === 'string' ? o.name.trim().slice(0, 40) : '';
		if (!name) throw new Error(`Material ${i + 1} needs a name`);
		if (seen.has(name.toLowerCase())) throw new Error(`${name} is listed twice`);
		seen.add(name.toLowerCase());
		const density = optNum(o.density, `${name}: density`, 5);
		if (!density || density < 0.5) throw new Error(`${name}: density must be 0.5–5 g/cm³`);
		return { name, pricePerKg: optNum(o.pricePerKg, `${name}: price per kg`, 10_000), density };
	});
	if (!materials.length) throw new Error('Keep at least one material');
	const defaultMaterial = typeof b.defaultMaterial === 'string' && materials.some((m) => m.name === b.defaultMaterial) ? b.defaultMaterial : materials[0].name;
	const diameter = optNum(b.diameter, 'Filament diameter', 5) ?? 1.75;
	if (diameter < 1) throw new Error('Filament diameter must be 1–5 mm');
	const s: CostSettings = {
		currency,
		electricityPerKwh: optNum(b.electricityPerKwh, 'Electricity price', 100),
		defaultPowerW: optNum(b.defaultPowerW, 'Power draw', 10_000),
		printerPowerW,
		materials,
		defaultMaterial,
		diameter,
		useSpoolmanPrices: b.useSpoolmanPrices !== false
	};
	setKv(KEY, s);
	return s;
}

/** The cost columns of a print, from per-tool use (with spools when known). */
export function costColumns(c: PrintCost) {
	return { filamentG: c.filamentG, material: c.material, costFilament: c.costFilament, costEnergy: c.costEnergy, costSource: c.source, pricePerKg: c.pricePerKg };
}

/** Costs a finished print and stores it on the entry. `tools` defaults to all of its filament on one unknown spool. */
export function costPrint(r: Pick<PrintRecord, 'id' | 'printerId' | 'filamentMm' | 'durationS'>, tools?: ToolUse[], settings = costSettings()): PrintCost {
	const uses = tools ?? (r.filamentMm != null ? [{ mm: r.filamentMm }] : []);
	const cost = computeCost({ tools: uses, durationS: r.durationS, powerW: powerOf(settings, r.printerId) }, settings);
	updatePrint(r.id, costColumns(cost));
	return cost;
}

type Row = Record<string, unknown>;

/**
 * Fills in the cost of finished entries that have none (`all`: recomputes every
 * finished entry with the current prices, keeping the spool price of entries costed
 * from Spoolman). Returns how many entries changed.
 */
export function backfillCosts(opts: { all?: boolean } = {}): number {
	const settings = costSettings();
	const rows = sqlite()
		.prepare(
			`SELECT id, printer_id, filament_mm, duration_s, filament_g, material, cost_source, price_per_kg FROM prints
			 WHERE result IN ('success', 'failed', 'cancelled') ${opts.all ? '' : 'AND cost_source IS NULL AND cost_filament IS NULL AND cost_energy IS NULL'}`
		)
		.all() as Row[];
	let changed = 0;
	const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	for (const r of rows) {
		const mm = num(r.filament_mm);
		const durationS = num(r.duration_s);
		const printerId = r.printer_id as string;
		let cost: PrintCost;
		if (r.cost_source === 'spool' && num(r.price_per_kg) != null) {
			// Costed from the spool's price at the time: keep that, update the electricity.
			const g = num(r.filament_g) ?? (mm != null ? gramsFromMm(mm, materialOf(settings, r.material as string).density, settings.diameter) : null);
			const energy = computeCost({ tools: [], durationS, powerW: powerOf(settings, printerId) }, settings).costEnergy;
			cost = {
				filamentG: g,
				costFilament: g != null ? Math.round((g / 1000) * (r.price_per_kg as number) * 10_000) / 10_000 : null,
				costEnergy: energy,
				material: (r.material as string) ?? null,
				pricePerKg: r.price_per_kg as number,
				source: 'spool'
			};
		} else {
			// Keep a material recorded from a spool (its density), else the default material.
			const spool = r.material ? { material: r.material as string, density: materialOf(settings, r.material as string).density, diameter: settings.diameter, pricePerKg: null } : null;
			cost = computeCost({ tools: mm != null ? [{ mm, spool }] : [], durationS, powerW: powerOf(settings, printerId) }, settings);
		}
		if (cost.filamentG == null && cost.costEnergy == null && !opts.all) continue;
		updatePrint(Number(r.id), costColumns(cost));
		changed++;
	}
	return changed;
}
