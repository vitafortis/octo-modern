/**
 * Common G-codes (Marlin, Prusa, Klipper's G-code layer, RepRapFirmware) with a short
 * description, for the terminal's autocomplete, and the commands that need an explicit
 * confirmation because they stop the machine, touch stored settings or firmware.
 * Shared by the terminal and the command route. Pure.
 */

export interface GcodeInfo {
	code: string;
	description: string;
	/** Why sending it needs a confirmation (the server insists too). */
	danger?: string;
}

export const GCODES: GcodeInfo[] = [
	{ code: 'G0', description: 'Rapid move' },
	{ code: 'G1', description: 'Linear move' },
	{ code: 'G2', description: 'Clockwise arc move' },
	{ code: 'G3', description: 'Counter-clockwise arc move' },
	{ code: 'G4', description: 'Dwell (P milliseconds, S seconds)' },
	{ code: 'G10', description: 'Retract (firmware retraction)' },
	{ code: 'G11', description: 'Recover (unretract)' },
	{ code: 'G20', description: 'Units: inches' },
	{ code: 'G21', description: 'Units: millimetres' },
	{ code: 'G28', description: 'Home axes (all, or X Y Z)' },
	{ code: 'G29', description: 'Bed leveling (probe the mesh)' },
	{ code: 'G30', description: 'Single Z probe' },
	{ code: 'G90', description: 'Absolute positioning' },
	{ code: 'G91', description: 'Relative positioning' },
	{ code: 'G92', description: 'Set current position' },
	{ code: 'M0', description: 'Unconditional stop: waits for the printer’s button', danger: 'M0/M1 halt the printer until someone presses its button.' },
	{ code: 'M1', description: 'Unconditional stop (sleep): waits for the printer’s button', danger: 'M0/M1 halt the printer until someone presses its button.' },
	{ code: 'M17', description: 'Enable steppers' },
	{ code: 'M18', description: 'Disable steppers (motors off)' },
	{ code: 'M20', description: 'List SD card files' },
	{ code: 'M21', description: 'Initialize SD card' },
	{ code: 'M22', description: 'Release SD card' },
	{ code: 'M23', description: 'Select SD file' },
	{ code: 'M24', description: 'Start or resume SD print' },
	{ code: 'M25', description: 'Pause SD print' },
	{ code: 'M27', description: 'Report SD print status' },
	{ code: 'M30', description: 'Delete SD file' },
	{ code: 'M42', description: 'Set pin state' },
	{ code: 'M48', description: 'Probe repeatability test' },
	{ code: 'M73', description: 'Set print progress' },
	{ code: 'M75', description: 'Start print job timer' },
	{ code: 'M76', description: 'Pause print job timer' },
	{ code: 'M77', description: 'Stop print job timer' },
	{ code: 'M80', description: 'Power supply on' },
	{ code: 'M81', description: 'Power supply off', danger: 'M81 switches the printer’s power supply off.' },
	{ code: 'M82', description: 'Extruder absolute mode' },
	{ code: 'M83', description: 'Extruder relative mode' },
	{ code: 'M84', description: 'Disable steppers (idle hold off)' },
	{ code: 'M85', description: 'Inactivity shutdown timeout' },
	{ code: 'M92', description: 'Set steps per unit', danger: 'M92 changes the motion calibration (steps per mm).' },
	{ code: 'M104', description: 'Set hotend temperature (no wait)' },
	{ code: 'M105', description: 'Report temperatures' },
	{ code: 'M106', description: 'Fan on (S0–255)' },
	{ code: 'M107', description: 'Fan off' },
	{ code: 'M109', description: 'Set hotend temperature and wait' },
	{ code: 'M110', description: 'Set current line number' },
	{ code: 'M112', description: 'Emergency stop', danger: 'M112 is an emergency stop: the printer halts immediately and needs a reset.' },
	{ code: 'M114', description: 'Report current position' },
	{ code: 'M115', description: 'Firmware info and capabilities' },
	{ code: 'M117', description: 'Show a message on the display' },
	{ code: 'M118', description: 'Echo a message to the host' },
	{ code: 'M119', description: 'Report endstop states' },
	{ code: 'M120', description: 'Enable endstops' },
	{ code: 'M121', description: 'Disable endstops' },
	{ code: 'M140', description: 'Set bed temperature (no wait)' },
	{ code: 'M141', description: 'Set chamber temperature' },
	{ code: 'M150', description: 'Set LED color' },
	{ code: 'M155', description: 'Temperature auto-report interval' },
	{ code: 'M190', description: 'Set bed temperature and wait' },
	{ code: 'M191', description: 'Set chamber temperature and wait' },
	{ code: 'M201', description: 'Set max acceleration' },
	{ code: 'M203', description: 'Set max feedrate' },
	{ code: 'M204', description: 'Set default acceleration' },
	{ code: 'M205', description: 'Advanced settings (jerk)' },
	{ code: 'M206', description: 'Set home offsets' },
	{ code: 'M207', description: 'Firmware retraction settings' },
	{ code: 'M211', description: 'Software endstops' },
	{ code: 'M218', description: 'Set hotend offset' },
	{ code: 'M220', description: 'Feedrate override (S percent)' },
	{ code: 'M221', description: 'Flow rate override (S percent)' },
	{ code: 'M226', description: 'Wait for pin state' },
	{ code: 'M280', description: 'Servo position' },
	{ code: 'M290', description: 'Babystep' },
	{ code: 'M300', description: 'Play a tone' },
	{ code: 'M301', description: 'Set hotend PID values' },
	{ code: 'M302', description: 'Allow cold extrusion', danger: 'M302 can allow extruding with a cold hotend, which can grind or jam filament.' },
	{ code: 'M303', description: 'PID autotune', danger: 'M303 heats the hotend or bed on its own for several minutes (PID autotune).' },
	{ code: 'M304', description: 'Set bed PID values' },
	{ code: 'M400', description: 'Wait for moves to finish' },
	{ code: 'M401', description: 'Deploy probe' },
	{ code: 'M402', description: 'Stow probe' },
	{ code: 'M410', description: 'Quickstop (abort all moves)', danger: 'M410 aborts all moves at once; the position is lost.' },
	{ code: 'M420', description: 'Bed leveling state (enable/load mesh)' },
	{ code: 'M428', description: 'Set home offsets from current position' },
	{ code: 'M500', description: 'Save settings to EEPROM', danger: 'M500 overwrites the settings stored in the printer’s EEPROM.' },
	{ code: 'M501', description: 'Load settings from EEPROM', danger: 'M501 replaces the current settings with those stored in EEPROM.' },
	{ code: 'M502', description: 'Reset settings to factory defaults', danger: 'M502 resets the firmware settings to factory defaults (and M500 would save that).' },
	{ code: 'M503', description: 'Report settings' },
	{ code: 'M504', description: 'Validate EEPROM contents' },
	{ code: 'M600', description: 'Filament change' },
	{ code: 'M851', description: 'Set Z probe offset' },
	{ code: 'M900', description: 'Linear advance factor' },
	{ code: 'M906', description: 'Set motor current', danger: 'M906 changes the stepper motor currents.' },
	{ code: 'M907', description: 'Set motor current (digipot)', danger: 'M907 changes the stepper motor currents.' },
	{ code: 'M997', description: 'Firmware update', danger: 'M997 starts a firmware update.' },
	{ code: 'M999', description: 'Restart after an emergency stop or error', danger: 'M999 restarts the firmware after a stop or error.' }
];

const BY_CODE = new Map(GCODES.map((g) => [g.code, g]));

/** The command of a line, normalized: `n12 m05 s1*33` → `M5`. Null for anything that isn't a G/M/T code. */
export function commandOf(line: string): string | null {
	const m = /^\s*(?:N\d+\s*)?([GMT])\s*(\d+)(?:\.\d+)?/i.exec(line);
	return m ? `${m[1].toUpperCase()}${Number(m[2])}` : null;
}

export function gcodeInfo(line: string): GcodeInfo | undefined {
	const c = commandOf(line);
	return c ? BY_CODE.get(c) : undefined;
}

/** Why a line needs confirming (stop, EEPROM, firmware…), or null. */
export function dangerReason(line: string): string | null {
	return gcodeInfo(line)?.danger ?? null;
}

/** G-codes whose code starts with what's typed (`m1` → M1, M17, M18, M104…), exact match first. */
export function completeGcode(token: string, limit = 8): GcodeInfo[] {
	const t = token.trim().toUpperCase();
	if (!/^[GM]\d*$/.test(t)) return [];
	const letter = t[0];
	const digits = t.slice(1).replace(/^0+(?=\d)/, '');
	const hits = GCODES.filter((g) => g.code[0] === letter && g.code.slice(1).startsWith(digits));
	hits.sort((a, b) => Number(b.code === letter + digits) - Number(a.code === letter + digits) || Number(a.code.slice(1)) - Number(b.code.slice(1)));
	return hits.slice(0, limit);
}

/** Commands whose arguments are free text (messages, file names): left as typed when uppercasing. */
const TEXT_ARGS = new Set(['M23', 'M28', 'M30', 'M32', 'M117', 'M118', 'M928']);

/**
 * Uppercases a G-code line for firmwares that are picky about case, leaving free-text
 * arguments (M117 messages, SD file names) and comments alone.
 */
export function uppercaseLine(line: string): string {
	const code = commandOf(line);
	const commentAt = line.search(/[;(]/);
	const body = commentAt === -1 ? line : line.slice(0, commentAt);
	const comment = commentAt === -1 ? '' : line.slice(commentAt);
	if (code && TEXT_ARGS.has(code)) {
		const m = /^(\s*(?:N\d+\s*)?[GMT]\s*\d+(?:\.\d+)?)(.*)$/i.exec(line)!;
		return m[1].toUpperCase() + m[2];
	}
	return body.toUpperCase() + comment;
}
