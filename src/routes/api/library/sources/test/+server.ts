import { json } from '@sveltejs/kit';
import { body, handler } from '#lib/server/http.ts';
import { getSource, getSourceSecrets, parseSourceConfig } from '#lib/server/library/sources.ts';
import { testSource } from '#lib/server/library/service.ts';
import type { SourceSecrets } from '#lib/library.ts';
import type { RequestHandler } from './$types';

/**
 * Tests a source form: connects and lists its root. `id` reuses the stored credentials
 * for fields left empty. Answers `{ ok, entries, sample, hostKey, latencyMs }` or `{ ok: false, error }`.
 */
export const POST: RequestHandler = handler(async ({ request }) => {
	const b = await body(request);
	const source = parseSourceConfig(b.kind, b.config);
	const stored = typeof b.id === 'string' && getSource(b.id)?.kind === source.kind ? getSourceSecrets(b.id) : {};
	const given = (b.secrets && typeof b.secrets === 'object' ? b.secrets : {}) as Record<string, unknown>;
	const secrets: SourceSecrets = { ...stored };
	for (const k of ['password', 'privateKey', 'passphrase'] as const) if (typeof given[k] === 'string' && given[k]) secrets[k] = given[k] as string;
	return json(await testSource(source, secrets));
});
