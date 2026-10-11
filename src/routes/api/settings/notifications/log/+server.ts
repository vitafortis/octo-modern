import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { clearDeliveries, listDeliveries } from '#lib/server/notify/log.ts';
import type { DeliveryStatus } from '#lib/notify.ts';
import type { RequestHandler } from './$types';

const STATUSES: DeliveryStatus[] = ['sent', 'failed', 'quiet', 'deduped', 'rate_limited'];

/** The latest deliveries: `?limit=100&status=failed`. */
export const GET: RequestHandler = handler(({ url }) => {
	const status = url.searchParams.get('status') as DeliveryStatus | null;
	return json({ items: listDeliveries(Number(url.searchParams.get('limit')) || 100, status && STATUSES.includes(status) ? status : undefined) });
});

export const DELETE: RequestHandler = handler(({ locals }) => {
	clearDeliveries();
	audit(locals, 'notifications.log.clear');
	return json({ ok: true });
});
