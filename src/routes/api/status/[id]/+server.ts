import { json } from '@sveltejs/kit';
import { printerStatus } from '#lib/server/status.ts';
import type { RequestHandler } from './$types';

/**
 * One printer's status. `?strict=1` answers 503 while OctoPrint is unreachable or the
 * printer is in an error state, for monitors that only look at the HTTP status.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const token = locals.apiToken;
	if (!token) return json({ message: 'API token required' }, { status: 401 });
	const item = await printerStatus(params.id, { includeAddresses: token.includeAddresses });
	if (!item) return json({ message: 'Printer not found' }, { status: 404 });
	const strict = url.searchParams.get('strict') === '1' || url.searchParams.get('strict') === 'true';
	const down = item.state === 'offline' || item.state === 'error';
	return json(item, { status: strict && down ? 503 : 200, headers: { 'cache-control': 'no-store' } });
};
