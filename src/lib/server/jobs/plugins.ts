/**
 * OctoPrint updates in the background: twice a day, asks every OctoPrint printer's Software
 * Update plugin (its cached answer; OctoPrint itself checks upstream about once a day), keeps
 * the result for the Care badge and notifies `octoprint.updates` once per new set of versions.
 */
import { defineJob } from '../jobs.ts';
import { checkAllUpdates, observePlugins } from '../plugins.ts';

defineJob({ name: 'plugins-observe', everyMs: 3600_000, initialDelayMs: 1_000, run: async () => observePlugins() });

defineJob({
	name: 'octoprint-updates',
	everyMs: 12 * 3600_000,
	initialDelayMs: 3 * 60_000,
	run: () => checkAllUpdates()
});
