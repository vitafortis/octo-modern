import { randomUUID } from 'node:crypto';
import { plainBody, type ChannelAdapter } from './adapter.ts';
import { DeliveryError, escapeHtml, imageName, jsonHeaders, request } from './http.ts';
import type { Message } from '../types.ts';
import { trimSlash } from '../render.ts';

export function matrixText(m: Message) {
	const facts = m.fields.filter((f) => f.label !== 'Printer');
	const html = [
		`<strong>${escapeHtml(m.title)}</strong>`,
		`<p>${escapeHtml(m.text)}</p>`,
		facts.length ? `<ul>${facts.map((f) => `<li>${escapeHtml(f.label)}: ${escapeHtml(f.value)}</li>`).join('')}</ul>` : '',
		m.url ? `<p><a href="${escapeHtml(m.url)}">Open in octo·modern</a></p>` : ''
	].join('');
	return { msgtype: m.severity === 'info' ? 'm.notice' : 'm.text', body: `${m.title}\n${plainBody(m)}`, format: 'org.matrix.custom.html', formatted_body: html };
}

export const matrix: ChannelAdapter = {
	type: 'matrix',
	validate: (c) => (/^![^:\s]+:\S+$/.test(c.roomId ?? '') ? null : 'The room ID looks like !abcdef:matrix.org (not the #alias)'),
	async send({ config, secrets, message: m }) {
		const hs = trimSlash(config.homeserver);
		const auth = { authorization: `Bearer ${secrets.accessToken}` };
		const room = encodeURIComponent(config.roomId);
		const put = (content: unknown) =>
			request(`${hs}/_matrix/client/v3/rooms/${room}/send/m.room.message/${randomUUID()}`, { method: 'PUT', headers: { ...jsonHeaders, ...auth }, body: JSON.stringify(content) });
		await put(matrixText(m));
		if (m.image) {
			const name = imageName(m.image);
			const up = await request(`${hs}/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`, { headers: { ...auth, 'content-type': m.image.type }, body: m.image.data as Uint8Array<ArrayBuffer> });
			let uri: unknown;
			try {
				uri = JSON.parse(up).content_uri;
			} catch {}
			if (typeof uri !== 'string' || !uri.startsWith('mxc://')) throw new DeliveryError('The homeserver accepted the upload but returned no content_uri');
			await put({ msgtype: 'm.image', body: name, url: uri, info: { mimetype: m.image.type, size: m.image.data.length } });
		}
	}
};
