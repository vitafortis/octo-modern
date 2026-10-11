import type { ChannelAdapter } from './adapter.ts';
import { jsonHeaders, request } from './http.ts';
import type { Message } from '../types.ts';

const mrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A Block Kit message: header, sentence, facts, the snapshot (by link) and a button back. */
export function slackPayload(m: Message) {
	const blocks: Record<string, unknown>[] = [
		{ type: 'header', text: { type: 'plain_text', text: m.title.slice(0, 150), emoji: true } },
		{ type: 'section', text: { type: 'mrkdwn', text: mrkdwn(m.text).slice(0, 3000) } }
	];
	const fields = m.fields.slice(0, 10).map((f) => ({ type: 'mrkdwn', text: `*${mrkdwn(f.label)}*\n${mrkdwn(f.value)}`.slice(0, 2000) }));
	if (fields.length) blocks.push({ type: 'section', fields });
	if (m.imageUrl) blocks.push({ type: 'image', image_url: m.imageUrl, alt_text: `Webcam snapshot${m.printer ? ` of ${m.printer.name}` : ''}` });
	if (m.url) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in octo·modern' }, url: m.url }] });
	blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `octo·modern · <!date^${Math.floor(Date.parse(m.at) / 1000)}^{date_short_pretty} {time}|${m.at}>` }] });
	return { text: `${m.title}: ${m.text}`.slice(0, 3000), blocks };
}

export const slack: ChannelAdapter = {
	type: 'slack',
	validate: (_c, s) => (/^https?:\/\//i.test(s.url ?? '') ? null : 'The webhook URL must be http(s)'),
	async send({ secrets, message }) {
		await request(secrets.url, { headers: jsonHeaders, body: JSON.stringify(slackPayload(message)) });
	}
};
