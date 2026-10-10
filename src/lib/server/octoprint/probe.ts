/**
 * "Test connection": reaches the server, checks the API key, and reports the
 * OctoPrint version and what the key may do.
 */
import { OctoPrintClient, type OctoTarget } from './client.ts';
import { OctoPrintError, toOctoPrintError } from './errors.ts';
import type { TestResult } from '#lib/types.ts';

/** OctoPrint permissions octo·modern uses, and what for. */
export const WANTED_PERMISSIONS: Record<string, string> = {
	STATUS: 'see printer state and temperatures',
	CONNECTION: 'connect and disconnect the printer',
	CONTROL: 'set temperatures, jog, send G-code',
	PRINT: 'start, pause and cancel prints',
	FILES_LIST: 'list files',
	FILES_UPLOAD: 'upload files',
	FILES_SELECT: 'select files to print',
	FILES_DELETE: 'delete files',
	WEBCAM: 'see the webcam',
	MONITOR_TERMINAL: 'see the terminal',
	SETTINGS_READ: 'read temperature presets and webcam settings',
	TIMELAPSE_LIST: 'list timelapses'
};

export async function testServer(target: OctoTarget, timeoutMs = 8_000): Promise<TestResult> {
	const client = new OctoPrintClient(target, timeoutMs);
	const started = performance.now();
	try {
		const version = await client.version();
		const latencyMs = Math.round(performance.now() - started);
		if (!version || typeof version.server !== 'string') {
			throw new OctoPrintError('That doesn’t look like OctoPrint', {
				code: 'NOT_OCTOPRINT',
				hint: 'GET /api/version didn’t return OctoPrint’s version. Check the URL (and its path, behind a proxy).'
			});
		}
		const user = await client.currentUser();
		// OctoPrint answers /api/currentuser for unknown keys too, as the anonymous guest.
		if (!user.name) {
			throw new OctoPrintError('API key not accepted', {
				code: 'HTTP_403',
				status: 403,
				hint: 'OctoPrint treats this key as an anonymous guest. Create an Application Key (Settings → Application Keys) or copy a user’s API key (User Settings → API key).'
			});
		}
		const perms = new Set(user.permissions);
		const admin = perms.has('ADMIN');
		const missing = admin ? [] : Object.keys(WANTED_PERMISSIONS).filter((p) => !perms.has(p));
		return { ok: true, version: version.server, apiVersion: version.api ?? null, user: user.name, permissions: user.permissions, missing, latencyMs };
	} catch (err) {
		const e = toOctoPrintError(err, client.host);
		return { ok: false, error: e.toJSON() };
	}
}
