import { jsonHeaders, request, imageName } from './http.ts';
import type { ChannelAdapter } from './adapter.ts';
import type { Message } from '../types.ts';
import { trimSlash } from '../render.ts';

/** RFC 2047, which ntfy decodes, for header values that aren't plain ASCII. */
export function headerValue(s: string): string {
	const flat = s.replace(/[\r\n]+/g, ' ');
	return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

export function ntfyTags(m: Message): string[] {
	const tag = m.kind === 'print.cancelled' ? 'stop_sign' : m.severity === 'success' ? 'white_check_mark' : m.severity === 'error' ? 'x' : m.severity === 'warning' ? 'warning' : 'bell';
	return [tag, 'octo-modern'];
}

export const ntfyPriority = (m: Message) => (m.kind === 'failure.suspected' ? 5 : m.severity === 'error' ? 4 : 3);

export const ntfy: ChannelAdapter = {
	type: 'ntfy',
	validate: (c) => (/^[-_A-Za-z0-9]{1,64}$/.test(c.topic ?? '') ? null : 'The topic may only have letters, digits, - and _ (64 at most)'),
	async send({ config, secrets, message: m }) {
		const server = trimSlash(config.server || 'https://ntfy.sh');
		const auth: Record<string, string> = secrets.token ? { authorization: `Bearer ${secrets.token}` } : {};
		if (m.image) {
			// An attachment: the image is the body, everything else goes in headers.
			const headers: Record<string, string> = {
				...auth,
				'content-type': m.image.type,
				'x-title': headerValue(m.title),
				'x-message': headerValue(m.text),
				'x-filename': imageName(m.image),
				'x-tags': ntfyTags(m).join(','),
				'x-priority': String(ntfyPriority(m))
			};
			if (m.url) headers['x-click'] = m.url;
			await request(`${server}/${encodeURIComponent(config.topic)}`, { method: 'PUT', headers, body: m.image.data as Uint8Array<ArrayBuffer> });
			return;
		}
		await request(server, {
			headers: { ...jsonHeaders, ...auth },
			body: JSON.stringify({ topic: config.topic, title: m.title, message: m.text, priority: ntfyPriority(m), tags: ntfyTags(m), ...(m.url ? { click: m.url } : {}) })
		});
	}
};
