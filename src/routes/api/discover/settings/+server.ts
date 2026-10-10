import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { discoveryEnv, getDiscoverySettings, listArcane, saveDiscoverySettings } from '#lib/server/discovery/config.ts';
import type { DiscoveryConfig } from '#lib/discovery.ts';
import type { RequestHandler } from './$types';

const view = (): DiscoveryConfig => ({ settings: getDiscoverySettings(), envDockerHosts: discoveryEnv.dockerHosts, managers: listArcane() });

export const GET: RequestHandler = () => json(view());

/** Saves extra Docker endpoints (`{ dockerHosts: [...] }`). */
export const PUT: RequestHandler = handler(async ({ request }) => {
	const b = await body(request);
	try {
		saveDiscoverySettings({ dockerHosts: Array.isArray(b.dockerHosts) ? b.dockerHosts.filter((h): h is string => typeof h === 'string') : undefined });
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	return json(view());
});
