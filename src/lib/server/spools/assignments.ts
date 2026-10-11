/**
 * Which Spoolman spool is loaded in which printer and tool (`spool_assignments`).
 */
import { sqlite } from '../store.ts';
import { printers } from '../octoprint/manager.ts';
import { spoolmanConfigured, spoolmanSettings, spoolsById } from './spoolman.ts';
import type { PrinterSpools, SpoolAssignment } from '#lib/spools.ts';

type Row = Record<string, unknown>;
const db = () => sqlite();

export interface Assignment {
	printerId: string;
	tool: number;
	spoolId: number;
	assignedAt: string;
	assignedBy: string | null;
}

const toAssignment = (r: Row): Assignment => ({
	printerId: r.printer_id as string,
	tool: Number(r.tool),
	spoolId: Number(r.spool_id),
	assignedAt: r.assigned_at as string,
	assignedBy: (r.assigned_by as string) ?? null
});

export function listAssignments(printerId: string): Assignment[] {
	return (db().prepare('SELECT * FROM spool_assignments WHERE printer_id = ? ORDER BY tool').all(printerId) as Row[]).map(toAssignment);
}

export function allAssignments(): Assignment[] {
	return (db().prepare('SELECT * FROM spool_assignments ORDER BY printer_id, tool').all() as Row[]).map(toAssignment);
}

/** Puts a spool on a tool (null takes it off). A spool sits on one tool at a time: it leaves any other. */
export function assignSpool(printerId: string, tool: number, spoolId: number | null, by: string | null): void {
	const h = db();
	h.exec('BEGIN');
	try {
		if (spoolId == null) h.prepare('DELETE FROM spool_assignments WHERE printer_id = ? AND tool = ?').run(printerId, tool);
		else {
			h.prepare('DELETE FROM spool_assignments WHERE spool_id = ? AND NOT (printer_id = ? AND tool = ?)').run(spoolId, printerId, tool);
			h.prepare(
				`INSERT INTO spool_assignments (printer_id, tool, spool_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(printer_id, tool) DO UPDATE SET spool_id = excluded.spool_id, assigned_at = excluded.assigned_at, assigned_by = excluded.assigned_by`
			).run(printerId, tool, spoolId, new Date().toISOString(), by);
		}
		h.exec('COMMIT');
	} catch (err) {
		h.exec('ROLLBACK');
		throw err;
	}
}

/** Number of tools of a printer, from its live temperatures (`tool0`, `tool1`…); at least 1. */
export function toolCount(printerId: string): number {
	const temps = printers.snapshot(printerId)?.temps ?? {};
	let n = 0;
	for (const k of Object.keys(temps)) {
		const m = /^tool(\d+)$/.exec(k);
		if (m) n = Math.max(n, Number(m[1]) + 1);
	}
	return Math.max(1, n);
}

/** A printer's spools with their Spoolman details, for the dashboard and the Filament page. */
export async function printerSpools(printerId: string): Promise<PrinterSpools> {
	const configured = spoolmanConfigured();
	const list = listAssignments(printerId);
	const tools = Math.max(toolCount(printerId), ...list.map((a) => a.tool + 1));
	let error: string | null = null;
	let byId = new Map();
	if (configured && list.length) {
		try {
			byId = await spoolsById(list.map((a) => a.spoolId));
		} catch (err) {
			error = (err as Error).message;
		}
	}
	const assignments: SpoolAssignment[] = list.map((a) => ({ tool: a.tool, spoolId: a.spoolId, spool: byId.get(a.spoolId) ?? null, assignedAt: a.assignedAt, assignedBy: a.assignedBy }));
	return { configured, tools, assignments, lowThresholdG: spoolmanSettings().lowThresholdG, error };
}
