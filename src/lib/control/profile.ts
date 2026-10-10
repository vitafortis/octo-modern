/**
 * OctoPrint printer profiles (/api/printerprofiles), reduced to what the Control tab
 * needs: build volume, heaters, extruders and per-axis speed and inversion. Pure.
 */

export type Axis = 'x' | 'y' | 'z' | 'e';

export interface AxisSettings {
	/** mm/min, OctoPrint's default jog speed for the axis. */
	speed: number;
	/** The UI flips the direction of this axis' buttons. */
	inverted: boolean;
}

export interface PrinterProfile {
	id: string;
	name: string;
	model: string | null;
	volume: {
		width: number;
		depth: number;
		height: number;
		formFactor: 'rectangular' | 'circular';
		/** Where 0,0 is: front left corner or the center of the bed. */
		origin: 'lowerleft' | 'center';
	};
	heatedBed: boolean;
	heatedChamber: boolean;
	extruders: number;
	/** The extruders share one nozzle (one hotend, several filaments). */
	sharedNozzle: boolean;
	nozzleDiameter: number;
	axes: Record<Axis, AxisSettings>;
}

/** OctoPrint's own defaults ("Generic RepRap Printer"). */
export const DEFAULT_PROFILE: PrinterProfile = {
	id: '_default',
	name: 'Default',
	model: null,
	volume: { width: 200, depth: 200, height: 200, formFactor: 'rectangular', origin: 'lowerleft' },
	heatedBed: true,
	heatedChamber: false,
	extruders: 1,
	sharedNozzle: false,
	nozzleDiameter: 0.4,
	axes: {
		x: { speed: 6000, inverted: false },
		y: { speed: 6000, inverted: false },
		z: { speed: 200, inverted: false },
		e: { speed: 300, inverted: false }
	}
};

const num = (v: unknown, fallback: number, min = 0) => {
	const n = Number(v);
	return Number.isFinite(n) && n > min ? n : fallback;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One profile object from OctoPrint, with OctoPrint's defaults for anything missing. */
export function parseProfile(raw: unknown): PrinterProfile {
	const p = obj(raw);
	const d = DEFAULT_PROFILE;
	const vol = obj(p.volume);
	const ext = obj(p.extruder);
	const axesRaw = obj(p.axes);
	const axes = Object.fromEntries(
		(['x', 'y', 'z', 'e'] as Axis[]).map((a) => {
			const ax = obj(axesRaw[a]);
			return [a, { speed: num(ax.speed, d.axes[a].speed), inverted: ax.inverted === true }];
		})
	) as Record<Axis, AxisSettings>;
	return {
		id: typeof p.id === 'string' ? p.id : d.id,
		name: typeof p.name === 'string' && p.name ? p.name : d.name,
		model: typeof p.model === 'string' && p.model ? p.model : null,
		volume: {
			width: num(vol.width, d.volume.width),
			depth: num(vol.depth, d.volume.depth),
			height: num(vol.height, d.volume.height),
			formFactor: vol.formFactor === 'circular' ? 'circular' : 'rectangular',
			origin: vol.origin === 'center' ? 'center' : 'lowerleft'
		},
		heatedBed: p.heatedBed !== false,
		heatedChamber: p.heatedChamber === true,
		extruders: Math.max(1, Math.min(16, Math.floor(num(ext.count, 1)))),
		sharedNozzle: ext.sharedNozzle === true,
		nozzleDiameter: num(ext.nozzleDiameter, d.nozzleDiameter),
		axes
	};
}

/**
 * The profile in use from /api/printerprofiles: the `current` one (the profile the
 * printer is connected with), else the default, else the first.
 */
export function currentProfile(raw: unknown): PrinterProfile {
	const list = Object.values(obj(obj(raw).profiles)).map(obj);
	const pick = list.find((p) => p.current === true) ?? list.find((p) => p.default === true) ?? list[0];
	return pick ? parseProfile(pick) : DEFAULT_PROFILE;
}
