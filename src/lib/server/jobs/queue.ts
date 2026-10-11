/**
 * Print queue: starts the dispatcher (which listens to live state and print ends) and
 * runs a dispatch pass every few seconds, in case a kick was missed.
 */
import { defineJob } from '../jobs.ts';
import { dispatcher } from '../queue/dispatcher.ts';
import { cleanTempUploads } from '../queue/files.ts';

let cleaned = false;

defineJob({
	name: 'print-queue',
	everyMs: 5_000,
	initialDelayMs: 3_000,
	run: async () => {
		dispatcher.start();
		if (!cleaned) {
			cleaned = true;
			await cleanTempUploads();
		}
		await dispatcher.tick();
	}
});
