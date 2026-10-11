/**
 * Bed meshes in the background: listens to the Bed Visualizer plugin's push messages on
 * every printer, and every 15 min checks whether the plugin is installed and stores its
 * saved mesh when it changed (meshes probed from OctoPrint's own UI or a print's start G-code).
 */
import { defineJob } from '../jobs.ts';
import { observePlugin, syncAll } from '../bedmesh.ts';

// Starts listening right away (idempotent; the job only exists to run it at start-up).
defineJob({ name: 'bedmesh-observe', everyMs: 3600_000, initialDelayMs: 1_000, run: async () => observePlugin() });

defineJob({
	name: 'bedmesh-sync',
	everyMs: 15 * 60_000,
	initialDelayMs: 20_000,
	run: () => syncAll()
});
