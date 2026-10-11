/**
 * Smart plugs: follows every printer's live state for auto power-off, refreshes plug
 * readings (on/off, watts) every 15 s, and lets auto power-off countdowns run out.
 */
import { defineJob } from '../jobs.ts';
import { power } from '../power/service.ts';

defineJob({
	name: 'power',
	everyMs: 5_000,
	initialDelayMs: 2_000,
	run: async () => {
		power.start();
		await power.tick();
	}
});
