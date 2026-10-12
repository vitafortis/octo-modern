/**
 * What each printer kind can do, for the UI (which tabs and buttons to show) and the
 * server (which routes answer). Pure: safe to import anywhere.
 *
 * Klipper printers are reached through Moonraker, the API server Mainsail and Fluidd
 * use. Features that exist only as OctoPrint plugins or concepts (serial connection
 * settings, the SD card, OctoPrint's timelapse, temperature presets in OctoPrint's
 * settings, "load without printing") have no Moonraker equivalent and are hidden.
 */
import type { Printer, PrinterKind } from './types.ts';

export const KIND_LABEL: Record<PrinterKind, string> = {
	octoprint: 'OctoPrint',
	moonraker: 'Klipper'
};

/** The server software octo·modern talks to, for messages like "Can't reach Moonraker". */
export const SERVER_LABEL: Record<PrinterKind, string> = {
	octoprint: 'OctoPrint',
	moonraker: 'Moonraker'
};

export interface KindFeatures {
	/** Serial port / baud rate connect and disconnect (OctoPrint); Klipper has firmware restart instead. */
	serialConnection: boolean;
	/** Klipper's FIRMWARE_RESTART / RESTART. */
	firmwareRestart: boolean;
	/** Files on the printer's own SD card. */
	sdCard: boolean;
	/** Select a file without printing it. */
	selectWithoutPrint: boolean;
	/** OctoPrint's bundled timelapse. */
	timelapse: boolean;
	/** Bed meshes from OctoPrint's Bed Visualizer plugin. */
	bedMesh: boolean;
	/** OctoPrint's GCODE scripts in custom controls. */
	gcodeScripts: boolean;
	/** OctoPrint's Plugin Manager and Software Update (Care › Plugins & updates). */
	pluginManager: boolean;
	/** Needs an API key (Moonraker may run on a trusted network without one). */
	keyRequired: boolean;
}

export const FEATURES: Record<PrinterKind, KindFeatures> = {
	octoprint: { serialConnection: true, firmwareRestart: false, sdCard: true, selectWithoutPrint: true, timelapse: true, bedMesh: true, gcodeScripts: true, pluginManager: true, keyRequired: true },
	moonraker: { serialConnection: false, firmwareRestart: true, sdCard: false, selectWithoutPrint: false, timelapse: false, bedMesh: false, gcodeScripts: false, pluginManager: false, keyRequired: false }
};

export function kindOf(p: Pick<Printer, 'kind'> | null | undefined): PrinterKind {
	return p?.kind === 'moonraker' ? 'moonraker' : 'octoprint';
}

export function features(p: Pick<Printer, 'kind'> | null | undefined): KindFeatures {
	return FEATURES[kindOf(p)];
}

/** Views of the printer page's tabs (Camera › Timelapses, Care › Bed mesh, Care › Plugins & updates) that need a feature this kind lacks. */
export function hiddenTabs(p: Pick<Printer, 'kind'> | null | undefined): Set<string> {
	const f = features(p);
	const out = new Set<string>();
	if (!f.timelapse) out.add('timelapse');
	if (!f.bedMesh) out.add('bed');
	if (!f.pluginManager) out.add('plugins');
	return out;
}

/**
 * Whether octo·modern can talk to the printer at all: OctoPrint needs a stored key;
 * Moonraker works without one (trusted clients) and answers 401 if it does need one.
 */
export function canReach(p: Pick<Printer, 'kind' | 'hasApiKey'>): boolean {
	return p.hasApiKey || !features(p).keyRequired;
}
