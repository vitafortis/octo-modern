/**
 * Spools, costs and maintenance in the background:
 * - after each print: report its filament to Spoolman, cost it, check maintenance
 * - every 30 s: report filament use of running prints (progressively) and retry failed reports
 * - every 10 min: `maintenance.due` notifications
 * - at start and every 6 h: cost history entries that have none yet
 */
import { defineJob } from '../jobs.ts';
import { history } from '../history/tracker.ts';
import { afterPrint } from '../spools/after-print.ts';
import { trackUsage } from '../spools/usage.ts';
import { notifyDue } from '../maintenance.ts';
import { backfillCosts } from '../costs.ts';

defineJob({
	name: 'spool-usage',
	everyMs: 30_000,
	initialDelayMs: 1_000,
	run: async () => {
		history.ended.add(afterPrint); // a Set: added once
		await trackUsage();
	}
});

defineJob({ name: 'maintenance-due', everyMs: 10 * 60_000, initialDelayMs: 30_000, run: async () => void (await notifyDue()) });

defineJob({
	name: 'cost-backfill',
	everyMs: 6 * 3600_000,
	initialDelayMs: 15_000,
	run: async () => {
		const n = backfillCosts();
		if (n) console.log(`[octo-modern] costed ${n} earlier prints`);
	}
});
