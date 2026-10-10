import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { testArcane } from '#lib/server/discovery/arcane.ts';
import { arcaneKey, listArcane, normalizeArcaneUrl, saveArcane } from '#lib/server/discovery/config.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json(listArcane());

/** Connects (or updates) an Arcane instance after checking the key works. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const b = await body(request);
	const id = typeof b.id === 'string' ? b.id : undefined;
	const name = typeof b.name === 'string' ? b.name : 'Arcane';
	let url: string;
	try {
		url = normalizeArcaneUrl(typeof b.url === 'string' ? b.url : '');
	} catch {
		throw new BadRequest('Enter Arcane’s URL, e.g. http://arcane.lan:3552');
	}
	const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
	const key = apiKey || (id ? arcaneKey(id) : undefined);
	if (!key) throw new BadRequest('Paste an Arcane API key');
	const test = await testArcane(url, key);
	if (!test.ok) throw new BadRequest(test.error);
	const manager = saveArcane({ id, name, url, apiKey: apiKey || undefined });
	audit(locals, 'discovery.arcane', { detail: `connected ${manager.name} (${manager.url})` });
	return json({ manager, environments: test.environments });
});
