/**
 * Notifications: hooks into the print history and every printer's live state (see
 * notify/bridge.ts) and runs the timers (offline grace period, hot-after-print).
 */
import { defineJob } from '../jobs.ts';
import { history } from '../history/tracker.ts';
import { bridge } from '../notify/bridge.ts';

defineJob({
	name: 'notifications',
	everyMs: 15_000,
	initialDelayMs: 0,
	run: async () => {
		history.start();
		bridge.start();
		bridge.tick();
	}
});
