import { COLORS, type ChannelAdapter } from './adapter.ts';
import { imageBlob, imageName, jsonHeaders, request } from './http.ts';
import type { Message } from '../types.ts';

export function discordPayload(m: Message) {
	const fields = m.fields.filter((f) => f.label !== 'Printer').slice(0, 25);
	return {
		username: 'octo·modern',
		embeds: [
			{
				title: m.title.slice(0, 256),
				description: m.text.slice(0, 4000),
				color: COLORS[m.severity],
				timestamp: m.at,
				...(m.url ? { url: m.url } : {}),
				...(m.printer ? { footer: { text: m.printer.name } } : {}),
				...(fields.length ? { fields: fields.map((f) => ({ name: f.label.slice(0, 256), value: f.value.slice(0, 1024), inline: true })) } : {}),
				...(m.image ? { image: { url: `attachment://${imageName(m.image)}` } } : {})
			}
		]
	};
}

export const discord: ChannelAdapter = {
	type: 'discord',
	validate: (_c, s) => (/^https?:\/\//i.test(s.url ?? '') ? null : 'The webhook URL must be http(s)'),
	async send({ secrets, message: m }) {
		const payload = discordPayload(m);
		if (!m.image) {
			await request(secrets.url, { headers: jsonHeaders, body: JSON.stringify(payload) });
			return;
		}
		const form = new FormData();
		form.set('payload_json', JSON.stringify(payload));
		form.set('files[0]', imageBlob(m.image), imageName(m.image));
		await request(secrets.url, { headers: { 'user-agent': 'octo-modern' }, body: form });
	}
};
