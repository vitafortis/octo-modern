/**
 * Polls printers that nobody is watching live, so the sidebar, overview and status
 * API stay current. Printers with an open push connection are skipped.
 */
import { config } from '../config.ts';
import { defineJob } from '../jobs.ts';
import { printers } from '../octoprint/manager.ts';

defineJob({
	name: 'printer-status',
	everyMs: config.pollIntervalMs,
	initialDelayMs: 1_000,
	run: () => printers.pollStale(config.pollIntervalMs - 500)
});
