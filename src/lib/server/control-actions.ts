/**
 * The Control tab's actions (POST /api/printers/<id>/control): validation, the
 * OctoPrint request for each, which ones move the machine (refused while printing),
 * and how each is audited (jogs coalesced per user and printer).
 */
import { BadRequest } from './http.ts';
import { parseCommands } from './control.ts';
import { audit } from './permissions.ts';
import { Coalescer, type Burst } from './audit-coalesce.ts';
import type { OctoPrintClient } from './octoprint/client.ts';
import { describeJog, fanCommand, FEEDRATE, FLOWRATE, MAX_EXTRUDE_MM, MAX_JOG_MM, type MoveAxis } from '#lib/control/jog.ts';
import type { Printer, User } from '#lib/types.ts';

export type ControlAction =
	| { action: 'jog'; x?: number; y?: number; z?: number }
	| { action: 'home'; axes: MoveAxis[] }
	| { action: 'feedrate'; factor: number }
	| { action: 'flowrate'; factor: number }
	| { action: 'fan'; speed: number }
	| { action: 'motors_off' }
	| { action: 'tool'; tool: string }
	| { action: 'extrude'; amount: number; tool?: string }
	| { action: 'custom'; name: string; commands?: string[]; script?: string; parameters?: Record<string, string> };

const AXES: MoveAxis[] = ['x', 'y', 'z'];

function number(v: unknown, label: string, min: number, max: number): number {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
	if (!Number.isFinite(n) || n < min || n > max) throw new BadRequest(`${label} must be a number from ${min} to ${max}`);
	return n;
}

function tool(v: unknown): string {
	if (typeof v !== 'string' || !/^tool\d{1,2}$/.test(v)) throw new BadRequest('"tool" must look like "tool0"');
	return v;
}

export function parseControlAction(b: Record<string, unknown>): ControlAction {
	switch (b.action) {
		case 'jog': {
			const out: { action: 'jog'; x?: number; y?: number; z?: number } = { action: 'jog' };
			for (const a of AXES) if (b[a] !== undefined && b[a] !== 0) out[a] = Math.round(number(b[a], a.toUpperCase(), -MAX_JOG_MM, MAX_JOG_MM) * 1000) / 1000;
			if (!AXES.some((a) => out[a])) throw new BadRequest('Nothing to move: give x, y or z in mm');
			return out;
		}
		case 'home': {
			const raw = b.axes === undefined ? AXES : b.axes;
			if (!Array.isArray(raw) || !raw.length || raw.some((a) => !AXES.includes(a as MoveAxis))) throw new BadRequest('"axes" must be a list of "x", "y" and "z"');
			return { action: 'home', axes: AXES.filter((a) => raw.includes(a)) };
		}
		case 'feedrate':
			return { action: 'feedrate', factor: Math.round(number(b.factor, 'Feed rate', FEEDRATE.min, FEEDRATE.max)) };
		case 'flowrate':
			return { action: 'flowrate', factor: Math.round(number(b.factor, 'Flow rate', FLOWRATE.min, FLOWRATE.max)) };
		case 'fan':
			return { action: 'fan', speed: Math.round(number(b.speed, 'Fan speed', 0, 100)) };
		case 'motors_off':
			return { action: 'motors_off' };
		case 'tool':
			return { action: 'tool', tool: tool(b.tool) };
		case 'extrude': {
			const amount = Math.round(number(b.amount, 'Length', -MAX_EXTRUDE_MM, MAX_EXTRUDE_MM) * 100) / 100;
			if (!amount) throw new BadRequest('Length must not be 0');
			return { action: 'extrude', amount, ...(b.tool !== undefined ? { tool: tool(b.tool) } : {}) };
		}
		case 'custom': {
			const name = typeof b.name === 'string' ? b.name.slice(0, 120) : 'Custom control';
			if (typeof b.script === 'string') {
				if (!/^[\w][\w./-]{0,127}$/.test(b.script) || b.script.includes('..')) throw new BadRequest('Invalid script name');
				const parameters: Record<string, string> = {};
				for (const [k, v] of Object.entries(b.parameters && typeof b.parameters === 'object' ? b.parameters : {})) {
					if (/^\w{1,64}$/.test(k) && (typeof v === 'string' || typeof v === 'number')) parameters[k] = String(v).slice(0, 256);
				}
				return { action: 'custom', name, script: b.script, parameters };
			}
			return { action: 'custom', name, commands: parseCommands(b.commands) };
		}
		default:
			throw new BadRequest('"action" must be one of jog, home, feedrate, flowrate, fan, motors_off, tool, extrude, custom');
	}
}

/** Actions that move the machine or change the active tool: refused while a print runs. */
export function isMovement(a: ControlAction): boolean {
	return a.action === 'jog' || a.action === 'home' || a.action === 'extrude' || a.action === 'motors_off' || a.action === 'tool';
}

/** Sends the action to OctoPrint (its own printhead/tool endpoints where it has them). */
export async function performControl(client: OctoPrintClient, a: ControlAction): Promise<void> {
	switch (a.action) {
		case 'jog': {
			const body: Record<string, unknown> = { command: 'jog' };
			for (const ax of AXES) if (a[ax]) body[ax] = a[ax];
			return client.post('/api/printer/printhead', body);
		}
		case 'home':
			return client.post('/api/printer/printhead', { command: 'home', axes: a.axes });
		case 'feedrate':
			return client.post('/api/printer/printhead', { command: 'feedrate', factor: a.factor });
		case 'flowrate':
			return client.post('/api/printer/tool', { command: 'flowrate', factor: a.factor });
		case 'fan':
			return client.sendCommands([fanCommand(a.speed)]);
		case 'motors_off':
			return client.sendCommands(['M18']);
		case 'tool':
			return client.post('/api/printer/tool', { command: 'select', tool: a.tool });
		case 'extrude':
			if (a.tool) await client.post('/api/printer/tool', { command: 'select', tool: a.tool });
			return client.post('/api/printer/tool', { command: 'extrude', amount: a.amount });
		case 'custom':
			if (a.script) return client.post('/api/printer/command', { script: a.script, parameters: a.parameters ?? {} });
			return client.sendCommands(a.commands ?? []);
	}
}

/** Audit action name and detail for everything but jogs. */
export function auditEntry(a: Exclude<ControlAction, { action: 'jog' }>): { action: string; detail: string } {
	switch (a.action) {
		case 'home':
			return { action: 'printer.home', detail: a.axes.length === 3 ? 'all axes' : a.axes.map((x) => x.toUpperCase()).join(' ') };
		case 'feedrate':
			return { action: 'printer.feedrate', detail: `${a.factor}%` };
		case 'flowrate':
			return { action: 'printer.flowrate', detail: `${a.factor}%` };
		case 'fan':
			return { action: 'printer.fan', detail: a.speed ? `${a.speed}% (${fanCommand(a.speed)})` : 'off (M107)' };
		case 'motors_off':
			return { action: 'printer.motors_off', detail: 'M18' };
		case 'tool':
			return { action: 'printer.tool', detail: a.tool };
		case 'extrude':
			return { action: 'printer.extrude', detail: `${a.amount > 0 ? 'extrude' : 'retract'} ${Math.abs(a.amount)} mm${a.tool ? ` (${a.tool})` : ''}` };
		case 'custom':
			return { action: 'printer.custom_control', detail: `${a.name}: ${a.script ? `script ${a.script}` : (a.commands ?? []).join(' · ')}`.slice(0, 480) };
	}
}

/** Summary of a burst of jogs: `3 jogs: X+10 ×2, Y-1 (net X+20 Y-1)`. */
export function summarizeJogs(moves: Partial<Record<MoveAxis, number>>[]): string {
	const runs: { text: string; n: number }[] = [];
	const net: Partial<Record<MoveAxis, number>> = {};
	for (const m of moves) {
		const text = describeJog(m);
		const last = runs.at(-1);
		if (last?.text === text) last.n++;
		else runs.push({ text, n: 1 });
		for (const a of AXES) if (m[a]) net[a] = Math.round(((net[a] ?? 0) + m[a]!) * 1000) / 1000;
	}
	const list = runs.map((r) => (r.n > 1 ? `${r.text} ×${r.n}` : r.text));
	const shown = list.length > 12 ? [...list.slice(0, 12), `… ${list.length - 12} more`] : list;
	if (moves.length === 1) return shown[0];
	return `${moves.length} jogs: ${shown.join(', ')} (net ${describeJog(net) || 'none'})`;
}

const jogs = new Coalescer<Partial<Record<MoveAxis, number>>>({ idleMs: 5_000, maxAgeMs: 60_000, maxItems: 200 });

type Locals = { user: User | null; ip?: string };

const jogKey = (locals: Locals, printer: Pick<Printer, 'id'>) => `${locals.user?.id ?? 'anon'}:${printer.id}`;

/** Audits a control action; consecutive jogs by one user on one printer become one entry. */
export function auditControl(locals: Locals, printer: Pick<Printer, 'id' | 'name'>, a: ControlAction) {
	const key = jogKey(locals, printer);
	if (a.action === 'jog') {
		const { action: _, ...move } = a;
		const snapshot = { user: locals.user, ip: locals.ip };
		jogs.add(key, move, (b: Burst<Partial<Record<MoveAxis, number>>>) => audit(snapshot, 'printer.jog', { printer, detail: summarizeJogs(b.items) }));
		return;
	}
	// Write the pending jogs first so the log keeps the order things happened in.
	jogs.flush(key);
	const e = auditEntry(a);
	audit(locals, e.action, { printer, detail: e.detail });
}

/** Writes any pending jog bursts now (tests, shutdown). */
export function flushControlAudit() {
	jogs.flushAll();
}
