import type { ChannelAdapter } from './adapter.ts';
import { escapeHtml, imageBlob, imageName, jsonHeaders, request } from './http.ts';
import type { Message } from '../types.ts';
import { trimSlash } from '../render.ts';

/** HTML for Telegram (bold title, sentence, facts, link), cut to `max` characters. */
export function telegramHtml(m: Message, max: number): string {
	const facts = m.fields.filter((f) => f.label !== 'Printer').map((f) => `${escapeHtml(f.label)}: ${escapeHtml(f.value)}`);
	const parts = [`<b>${escapeHtml(m.title)}</b>`, escapeHtml(m.text), facts.join('\n'), m.url ? `<a href="${escapeHtml(m.url)}">Open in octo·modern</a>` : ''].filter(Boolean);
	let html = parts.join('\n\n');
	// Drop the facts rather than cut through a tag.
	if (html.length > max) html = [`<b>${escapeHtml(m.title)}</b>`, escapeHtml(m.text)].join('\n\n').slice(0, max);
	return html;
}

export const telegram: ChannelAdapter = {
	type: 'telegram',
	validate: (c, s) => (!/^\d+:[\w-]+$/.test(s.botToken ?? '') ? 'That doesn’t look like a bot token (123456:ABC…)' : /^(-?\d+|@\w+)$/.test(c.chatId ?? '') ? null : 'The chat ID is a number (e.g. -100…) or @channelname'),
	async send({ config, secrets, message: m }) {
		const base = `${trimSlash(config.server || 'https://api.telegram.org')}/bot${secrets.botToken}`;
		if (m.image) {
			const form = new FormData();
			form.set('chat_id', config.chatId);
			form.set('photo', imageBlob(m.image), imageName(m.image));
			form.set('caption', telegramHtml(m, 1024));
			form.set('parse_mode', 'HTML');
			await request(`${base}/sendPhoto`, { body: form });
			return;
		}
		await request(`${base}/sendMessage`, {
			headers: jsonHeaders,
			body: JSON.stringify({ chat_id: config.chatId, text: telegramHtml(m, 4096), parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
		});
	}
};
