/**
 * Smart plug power control: types shared by the server and the browser. Pure.
 */

export type PlugKind = 'shelly' | 'tasmota' | 'homeassistant' | 'http';
export const PLUG_KINDS: PlugKind[] = ['shelly', 'tasmota', 'homeassistant', 'http'];
export const PLUG_LABEL: Record<PlugKind, string> = { shelly: 'Shelly', tasmota: 'Tasmota', homeassistant: 'Home Assistant', http: 'HTTP' };

/** What a plug reports. `on` is null when it can't tell (e.g. an HTTP plug without a status URL). */
export interface PlugReading {
	on: boolean | null;
	/** Current draw in watts, when the device measures it. */
	powerW: number | null;
	/** Energy counter in Wh (the device's own total), when it measures it. */
	energyWh: number | null;
	voltageV: number | null;
}

export interface AutoOffSettings {
	enabled: boolean;
	/** Wait until every hotend is below this (°C). */
	hotendC: number;
	/** …and the printer has been idle this long after the print ended (minutes). */
	idleMinutes: number;
	/** Stay on while print-queue jobs wait for this printer's bed to be cleared. */
	waitForQueue: boolean;
}

export interface PowerSettings {
	/** Connect OctoPrint to the printer after powering it on (with retries). */
	autoConnect: boolean;
	/** Power on automatically when a print is sent to a printer that's off. */
	autoOn: boolean;
	autoOff: AutoOffSettings;
	/** Turning off while the hotend is at least this hot (°C) needs confirming. */
	hotHotendC: number;
	/** Turning off while the bed is at least this hot (°C) needs confirming. */
	hotBedC: number;
}

export const DEFAULT_POWER_SETTINGS: PowerSettings = {
	autoConnect: true,
	autoOn: false,
	autoOff: { enabled: false, hotendC: 50, idleMinutes: 10, waitForQueue: true },
	hotHotendC: 50,
	hotBedC: 40
};

/** The auto power-off countdown after a print, while it runs. */
export interface AutoOffCountdown {
	/** Epoch ms the print ended (the countdown started). */
	since: number;
	/** Epoch ms the idle time is up. */
	offAt: number;
	/** Hottest hotend now (°C), when known. */
	hotendC: number | null;
	/** Below this the hotend counts as cool. */
	targetC: number;
	/** Still waiting for the hotend to cool down (the idle time may be up already). */
	cooling: boolean;
	/** Due, but held back (e.g. queued jobs wait for the bed to be cleared). */
	heldBy: string | null;
}

export type ConnectPhase = 'waiting' | 'connecting' | 'connected' | 'failed';

/** A plug as anyone who can see the printer sees it: no addresses, no secrets. */
export interface PowerInfo {
	printerId: string;
	kind: PlugKind;
	label: string | null;
	reading: PlugReading | null;
	/** Epoch ms of the last reading. */
	readAt: number | null;
	/** Why the last reading or switch failed. */
	error: string | null;
	settings: PowerSettings;
	countdown: AutoOffCountdown | null;
	/** Auto-connect progress after a power-on. */
	connect: { phase: ConnectPhase; attempt: number; message: string | null; at: number } | null;
	/** A switch is in progress. */
	busy: boolean;
}

/** A plug's configuration as an admin edits it; secrets are replaced by hints. */
export interface PlugConfigView {
	kind: PlugKind;
	label: string | null;
	config: Record<string, string | number | boolean>;
	/** Which secrets are stored, as safe hints (never the values). */
	secrets: Record<string, string>;
	settings: PowerSettings;
	updatedAt: string;
}

export function formatWatts(w: number | null | undefined): string {
	if (w == null || !Number.isFinite(w)) return '—';
	if (Math.abs(w) >= 1000) return `${(w / 1000).toFixed(2)} kW`;
	return `${w >= 100 ? Math.round(w) : w.toFixed(1)} W`;
}

export function formatEnergy(wh: number | null | undefined): string {
	if (wh == null || !Number.isFinite(wh)) return '—';
	if (Math.abs(wh) >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
	return `${Math.round(wh)} Wh`;
}

/** `4:05` (or `1:02:03`). */
export function formatCountdown(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
