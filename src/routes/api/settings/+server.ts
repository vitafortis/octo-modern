import { json } from '@sveltejs/kit';
import { config, IN_CONTAINER } from '#lib/server/config.ts';
import type { RequestHandler } from './$types';

/** Read-only facts about this install, for the Settings page (admins). */
export const GET: RequestHandler = () =>
	json({
		env: {
			dataDir: config.dataDir,
			keySource: config.secretKey ? 'OCM_SECRET_KEY' : 'key file',
			authDisabled: config.authDisabled,
			inContainer: IN_CONTAINER,
			pollIntervalMs: config.pollIntervalMs,
			requestTimeoutMs: config.requestTimeoutMs,
			pushThrottle: config.pushThrottle,
			tempHistoryMinutes: config.tempHistoryMinutes
		}
	});
