/**
 * Motion and tool controls: jog vectors with the profile's axis inversion, which step
 * sizes fit the build volume, when movement is allowed, and the limits the server
 * enforces. Shared by the Control tab and the control route. Pure.
 */
import { isConnected, type PrinterState } from '#lib/printer.ts';
import type { PrinterProfile } from './profile.ts';

export const JOG_STEPS = [0.1, 1, 10, 100] as const;
export const EXTRUDE_LENGTHS = [1, 5, 10, 50, 100] as const;

/** Speed and flow overrides, in percent (OctoPrint's own UI uses the same ranges). */
export const FEEDRATE = { min: 50, max: 200 };
export const FLOWRATE = { min: 75, max: 125 };
/** Longest single jog and extrusion the server accepts, in mm. */
export const MAX_JOG_MM = 1000;
export const MAX_EXTRUDE_MM = 500;
/** Below this hotend temperature most firmware refuses to extrude (cold extrusion prevention). */
export const MIN_EXTRUDE_TEMP = 170;

export type MoveAxis = 'x' | 'y' | 'z';
export type Direction = -1 | 0 | 1;

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The relative move for a button press: `dir` per axis (+1 is right/back/up as the user
 * sees it), times the step, flipped for axes the profile marks inverted. Axes that
 * don't move are left out.
 */
export function jogVector(dir: Partial<Record<MoveAxis, Direction>>, step: number, profile: Pick<PrinterProfile, 'axes'>): Partial<Record<MoveAxis, number>> {
	const out: Partial<Record<MoveAxis, number>> = {};
	for (const axis of ['x', 'y', 'z'] as MoveAxis[]) {
		const d = dir[axis] ?? 0;
		if (!d) continue;
		const sign = profile.axes[axis].inverted ? -1 : 1;
		out[axis] = round(d * step * sign);
	}
	return out;
}

/** Length of an axis in the build volume (a circular bed's diameter is its width). */
export function axisLength(profile: Pick<PrinterProfile, 'volume'>, axis: MoveAxis): number {
	const v = profile.volume;
	return axis === 'x' ? v.width : axis === 'y' ? (v.formFactor === 'circular' ? v.width : v.depth) : v.height;
}

/** A step fits when it isn't longer than the axis it moves (no 100 mm jogs on a 90 mm bed). */
export function stepFits(step: number, profile: Pick<PrinterProfile, 'volume'>, axes: MoveAxis[]): boolean {
	return axes.every((a) => step <= axisLength(profile, a));
}

/** Why the head can't be moved right now (jog, home, extrude, motors off, tool change), or null. */
export function movementBlocked(state: PrinterState): string | null {
	switch (state) {
		case 'printing':
		case 'pausing':
		case 'resuming':
		case 'finishing':
			return 'A print is running. Movement is disabled until it ends or is paused.';
		case 'cancelling':
			return 'The print is being cancelled. Wait until the printer is ready.';
		case 'error':
			return 'The printer reported an error. Reconnect it to move it again.';
		default:
			return isConnected(state) ? null : 'Connect the printer to move it.';
	}
}

/** Fan G-code for a speed in percent: off is M107, anything else M106 S0–255. */
export function fanCommand(percent: number): string {
	const p = Math.max(0, Math.min(100, Math.round(percent)));
	return p === 0 ? 'M107' : `M106 S${Math.round((p * 255) / 100)}`;
}

/** `X+10 Y-1`: a compact description of a jog for the audit log. */
export function describeJog(v: Partial<Record<MoveAxis, number>>): string {
	return (['x', 'y', 'z'] as MoveAxis[])
		.filter((a) => v[a])
		.map((a) => `${a.toUpperCase()}${v[a]! > 0 ? '+' : ''}${v[a]}`)
		.join(' ');
}
