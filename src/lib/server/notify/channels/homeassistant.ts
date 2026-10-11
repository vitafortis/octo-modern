import type { ChannelAdapter } from './adapter.ts';
import { jsonHeaders, request } from './http.ts';
import { webhookPayload } from './webhook.ts';
import type { Message } from '../types.ts';
import { trimSlash } from '../render.ts';

export const haService = (s: string | undefined) => (s ?? '').trim().replace(/^notify\./, '');

export function haNotifyPayload(m: Message) {
	const data: Record<string, unknown> = { group: 'octo-modern', tag: `octo-modern-${m.printer?.id ?? 'all'}-${m.kind}` };
	if (m.url) Object.assign(data, { url: m.url, clickAction: m.url });
	if (m.imageUrl) data.image = m.imageUrl;
	if (m.severity === 'error') Object.assign(data, { priority: 'high', ttl: 0, push: { 'interruption-level': 'time-sensitive' } });
	return { title: m.title, message: m.text, data };
}

export const homeassistant: ChannelAdapter = {
	type: 'homeassistant',
	validate(c, s) {
		const service = haService(c.service);
		if (!s.webhookId && !service) return 'Set a webhook ID, a notify service, or both';
		if (service && !/^[a-z0-9_]+$/.test(service)) return 'The notify service is a name like mobile_app_my_phone';
		if (service && !s.token) return 'Calling a notify service needs a long-lived access token';
		if (s.webhookId && !/^[\w-]+$/.test(s.webhookId)) return 'The webhook ID has unexpected characters';
		return null;
	},
	async send({ config, secrets, message }) {
		const base = trimSlash(config.baseUrl);
		const service = haService(config.service);
		const jobs: Promise<string>[] = [];
		if (secrets.webhookId) jobs.push(request(`${base}/api/webhook/${encodeURIComponent(secrets.webhookId)}`, { headers: jsonHeaders, body: JSON.stringify(webhookPayload(message, '2')) }));
		if (service && secrets.token)
			jobs.push(request(`${base}/api/services/notify/${service}`, { headers: { ...jsonHeaders, authorization: `Bearer ${secrets.token}` }, body: JSON.stringify(haNotifyPayload(message)) }));
		const results = await Promise.allSettled(jobs);
		const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
		if (failed.length) {
			const labels = secrets.webhookId && service ? ['webhook', 'notify service'] : [secrets.webhookId ? 'webhook' : 'notify service'];
			const msgs = results.map((r, i) => (r.status === 'rejected' ? `${labels[i]}: ${(r.reason as Error).message}` : null)).filter(Boolean);
			throw Object.assign(failed[0].reason as Error, { message: msgs.join('; ') });
		}
	}
};
