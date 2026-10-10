import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { scanSubnet } from '#lib/server/discovery/lan.ts';
import { saveDiscoverySettings } from '#lib/server/discovery/config.ts';
import { prepare } from '#lib/server/discovery/index.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

let running = false;

/** Scans addresses an admin entered (`{ targets, ports }`) and fingerprints what answers. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const b = await body(request);
	const targets = typeof b.targets === 'string' ? b.targets : '';
	const ports = typeof b.ports === 'string' ? b.ports : '';
	if (running) throw new BadRequest('A subnet scan is already running');
	running = true;
	try {
		const scan = await scanSubnet(targets, ports).catch((err) => {
			throw new BadRequest((err as Error).message);
		});
		saveDiscoverySettings({ subnet: { cidr: targets, ports } });
		audit(locals, 'discovery.scan', { detail: `subnet ${scan.scope}: ${scan.candidates.length} found` });
		prepare(scan.candidates);
		return json(scan);
	} finally {
		running = false;
	}
});
