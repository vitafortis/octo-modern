import type { ChannelAdapter } from './adapter.ts';
import { jsonHeaders, request } from './http.ts';
import type { Message } from '../types.ts';

/** Version 1's `event` names for the end of a print; other kinds keep their own name. */
const V1_EVENT: Record<string, string> = { 'print.finished': 'success', 'print.failed': 'failed', 'print.cancelled': 'cancelled', test: 'test' };

function v1Print(m: Message) {
	const p = m.print;
	if (!p) return null;
	return {
		id: p.id ?? null,
		file: p.file ?? null,
		path: p.path ?? null,
		startedAt: p.startedAt ?? null,
		endedAt: p.endedAt ?? null,
		durationS: p.elapsedS ?? null,
		filamentMm: p.filamentMm ?? null,
		completion: p.completion ?? null,
		startedBy: p.startedBy ?? null,
		reason: p.reason ?? null
	};
}

/**
 * The JSON body POSTed to generic webhooks (and Home Assistant webhook triggers),
 * documented in the README. Version 1 is the shape from before the notifications
 * rework (kept for channels that were set up then); version 2 adds every event kind.
 */
export function webhookPayload(m: Message, version: '1' | '2' = '2', includeImage = false) {
	if (version === '1') {
		return { source: 'octo-modern', version: 1, event: V1_EVENT[m.kind] ?? m.kind, title: m.title, message: m.text, printer: m.printer, print: v1Print(m), at: m.at, url: m.url };
	}
	return {
		source: 'octo-modern',
		version: 2,
		event: m.kind,
		severity: m.severity,
		title: m.title,
		message: m.text,
		printer: m.printer,
		print: m.print,
		fields: m.fields,
		data: m.data,
		at: m.at,
		url: m.url,
		imageUrl: m.imageUrl,
		...(includeImage && m.image ? { image: { contentType: m.image.type, base64: Buffer.from(m.image.data).toString('base64') } } : {})
	};
}

export const webhook: ChannelAdapter = {
	type: 'webhook',
	validate: (_c, s) => (/^https?:\/\//i.test(s.url ?? '') ? null : 'The URL must be http(s)'),
	async send({ config, secrets, message }) {
		const headers: Record<string, string> = { ...jsonHeaders };
		if (secrets.authorization) headers.authorization = secrets.authorization;
		await request(secrets.url, { headers, body: JSON.stringify(webhookPayload(message, config.format === '1' ? '1' : '2', config.includeImage === 'true')) });
	}
};
