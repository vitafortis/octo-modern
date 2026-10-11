import type { ChannelAdapter } from './adapter.ts';
import { jsonHeaders, request } from './http.ts';
import type { Message } from '../types.ts';
import { trimSlash } from '../render.ts';

export function gotifyPayload(m: Message) {
	const facts = m.fields.filter((f) => f.label !== 'Printer').map((f) => `- **${f.label}:** ${f.value}`);
	const md = [m.text, facts.join('\n'), m.imageUrl ? `![snapshot](${m.imageUrl})` : '', m.url ? `[Open in octo·modern](${m.url})` : ''].filter(Boolean).join('\n\n');
	const notification: Record<string, unknown> = {};
	if (m.url) notification.click = { url: m.url };
	if (m.imageUrl) notification.bigImageUrl = m.imageUrl;
	return {
		title: m.title,
		message: md,
		priority: m.severity === 'error' ? 8 : m.severity === 'warning' ? 6 : 4,
		extras: { 'client::display': { contentType: 'text/markdown' }, ...(Object.keys(notification).length ? { 'client::notification': notification } : {}) }
	};
}

export const gotify: ChannelAdapter = {
	type: 'gotify',
	async send({ config, secrets, message }) {
		await request(`${trimSlash(config.server)}/message`, { headers: { ...jsonHeaders, 'x-gotify-key': secrets.appToken }, body: JSON.stringify(gotifyPayload(message)) });
	}
};
