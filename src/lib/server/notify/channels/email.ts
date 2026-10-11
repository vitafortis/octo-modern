import nodemailer from 'nodemailer';
import { plainBody, type ChannelAdapter } from './adapter.ts';
import { DeliveryError, escapeHtml, imageName } from './http.ts';
import type { Message } from '../types.ts';

const ACCENT: Record<string, string> = { success: '#16a34a', error: '#dc2626', warning: '#d97706', info: '#7c3aed' };

export function emailHtml(m: Message, cid: string | null): string {
	const rows = m.fields
		.map((f) => `<tr><td style="padding:4px 12px 4px 0;color:#71717a;white-space:nowrap">${escapeHtml(f.label)}</td><td style="padding:4px 0">${escapeHtml(f.value)}</td></tr>`)
		.join('');
	return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#18181b">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border-top:4px solid ${ACCENT[m.severity]};padding:20px 24px">
<h2 style="margin:0 0 8px;font-size:17px">${escapeHtml(m.title)}</h2>
<p style="margin:0 0 16px">${escapeHtml(m.text)}</p>
${cid ? `<img src="cid:${cid}" alt="Webcam snapshot" style="display:block;max-width:100%;border-radius:8px;margin:0 0 16px">` : ''}
${rows ? `<table style="border-collapse:collapse;font-size:13px;margin:0 0 16px">${rows}</table>` : ''}
${m.url ? `<p style="margin:0"><a href="${escapeHtml(m.url)}" style="color:#7c3aed">Open in octo·modern</a></p>` : ''}
</div><p style="text-align:center;color:#a1a1aa;font-size:12px">Sent by octo·modern</p></body></html>`;
}

/** Transport options from the channel's settings (exported for tests). */
export function transportOptions(config: Record<string, string>, secrets: Record<string, string>) {
	const security = config.security || 'starttls';
	const port = Number(config.port) || (security === 'tls' ? 465 : security === 'none' ? 25 : 587);
	return {
		host: config.host,
		port,
		secure: security === 'tls',
		requireTLS: security === 'starttls',
		ignoreTLS: security === 'none',
		auth: config.username ? { user: config.username, pass: secrets.password ?? '' } : undefined,
		tls: { rejectUnauthorized: config.allowSelfSigned !== 'true', servername: config.host },
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 15_000
	};
}

const recipients = (to: string) => to.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export const email: ChannelAdapter = {
	type: 'email',
	validate(c) {
		if (!/^[\w.-]+$/.test(c.host ?? '')) return 'The SMTP server is a host name or IP address';
		if (c.port && !(Number(c.port) > 0 && Number(c.port) < 65536)) return 'The port is a number from 1 to 65535';
		if (!EMAIL.test(c.from ?? '')) return '“From” must be an email address';
		const to = recipients(c.to ?? '');
		if (!to.length || to.length > 20 || !to.every((a) => EMAIL.test(a))) return '“To” must be one or more email addresses, separated by commas';
		return null;
	},
	async send({ config, secrets, message: m }) {
		const transport = nodemailer.createTransport(transportOptions(config, secrets));
		const cid = m.image ? 'snapshot@octo-modern' : null;
		try {
			await transport.sendMail({
				from: config.from,
				to: recipients(config.to),
				subject: m.title,
				text: plainBody(m),
				html: emailHtml(m, cid),
				attachments: m.image ? [{ filename: imageName(m.image), content: Buffer.from(m.image.data), contentType: m.image.type, cid: cid! }] : []
			});
		} catch (err) {
			const e = err as Error & { code?: string; response?: string };
			throw new DeliveryError(e.response ? `${e.code ? `${e.code}: ` : ''}${e.response}` : `${e.code && !e.message.includes(e.code) ? `${e.code}: ` : ''}${e.message}`);
		} finally {
			transport.close();
		}
	}
};
