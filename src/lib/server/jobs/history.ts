/**
 * Print history: starts the tracker (which records every print from the live state
 * of all printers, see history/tracker.ts; notifications hook in from jobs/notify.ts), and imports each
 * printer's earlier prints from OctoPrint once, the first time it's reachable.
 */
import { defineJob } from '../jobs.ts';
import { printers } from '../octoprint/manager.ts';
import { listPrinters } from '../store.ts';
import { history } from '../history/tracker.ts';
import { importedAt, importHistory } from '../history/import.ts';

defineJob({
	name: 'print-history',
	everyMs: 60_000,
	initialDelayMs: 0,
	run: async () => {
		history.start();
		for (const p of listPrinters()) {
			if (!p.hasApiKey || importedAt(p.id)) continue;
			const state = printers.snapshot(p.id)?.state;
			if (!state || state === 'offline' || state === 'unknown') continue;
			try {
				const r = await importHistory(p);
				if (r.imported) console.log(`[octo-modern] imported ${r.imported} earlier prints of ${p.name} from OctoPrint (${r.sources.join(', ')})`);
			} catch (err) {
				console.warn(`[octo-modern] couldn't import the print history of ${p.name}: ${(err as Error).message}`);
			}
		}
	}
});
