/**
 * What happens after every print (a history `ended` listener): its filament goes to
 * Spoolman, its cost is stored on the entry, and maintenance tasks it made overdue notify.
 */
import { costPrint } from '../costs.ts';
import { notifyDue } from '../maintenance.ts';
import { finishUsage, type ToolShare } from './usage.ts';
import { spoolmanConfigured, spoolsById } from './spoolman.ts';
import type { SpoolSummary } from '#lib/spools.ts';
import type { PrintRecord } from '#lib/history.ts';

export async function afterPrint(record: PrintRecord): Promise<void> {
	let shares: ToolShare[] = [];
	try {
		shares = await finishUsage(record);
	} catch (err) {
		console.error('[octo-modern] filament use: failed', err);
	}
	let spools = new Map<number, SpoolSummary>();
	const ids = shares.map((s) => s.spoolId).filter((id): id is number => id != null);
	if (ids.length && spoolmanConfigured()) spools = await spoolsById(ids).catch(() => new Map());
	try {
		costPrint(record, shares.length ? shares.map((s) => ({ mm: s.mm, spool: s.spoolId != null ? (spools.get(s.spoolId) ?? null) : null })) : undefined);
	} catch (err) {
		console.error('[octo-modern] print cost: failed', err);
	}
	await notifyDue().catch((err) => console.error('[octo-modern] maintenance check failed', err));
}
