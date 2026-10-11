/**
 * Failure detection (detect/service.ts): checks every second which printing printers
 * are due a frame; each printer's own interval decides how often one is sent.
 * Frames run in the background, so a slow ML API never delays the other printers.
 */
import { defineJob } from '../jobs.ts';
import { tick } from '../detect/service.ts';

defineJob({
	name: 'failure-detection',
	everyMs: 1_000,
	initialDelayMs: 5_000,
	run: async () => {
		tick();
	}
});
