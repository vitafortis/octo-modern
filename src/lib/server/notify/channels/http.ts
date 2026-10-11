/**
 * HTTP for channel adapters: a timeout, no redirects (a webhook that redirects is
 * misconfigured, and following one could leak the body elsewhere), and errors that
 * say exactly what the service answered.
 */

export class DeliveryError extends Error {
	status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = 'DeliveryError';
		this.status = status;
	}
}

export const TIMEOUT_MS = 15_000;

/** The most useful part of an error body: a JSON `description`/`error`/`message`/`errors`, else the text. */
export function errorDetail(text: string): string {
	const t = text.trim();
	try {
		const j = JSON.parse(t) as Record<string, unknown>;
		if (j && typeof j === 'object') {
			const pick = j.description ?? j.error_description ?? (typeof j.error === 'string' ? j.error : null) ?? j.message ?? (Array.isArray(j.errors) ? j.errors.join('; ') : null);
			const code = typeof j.errcode === 'string' ? `${j.errcode}: ` : '';
			if (typeof pick === 'string' && pick) return `${code}${pick}`.slice(0, 300);
		}
	} catch {}
	return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function checkUrl(url: string | undefined, what = 'URL'): string {
	if (!url || !/^https?:\/\/[^\s/]+/i.test(url)) throw new DeliveryError(`The channel has no valid http(s) ${what}`);
	return url;
}

/** Sends a request; resolves with the response text on 2xx, throws a DeliveryError otherwise. */
export async function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit | null }): Promise<string> {
	checkUrl(url);
	let res: Response;
	try {
		res = await fetch(url, { method: init.method ?? 'POST', headers: init.headers, body: init.body ?? undefined, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
	} catch (err) {
		const e = err as Error & { cause?: { code?: string; message?: string; address?: string; port?: number } };
		if (e.name === 'TimeoutError') throw new DeliveryError(`No answer within ${TIMEOUT_MS / 1000} s`);
		const c = e.cause;
		const where = c?.address ? ` ${c.address}${c.port ? `:${c.port}` : ''}` : '';
		throw new DeliveryError(c?.code ? `${c.code}${where}` : (c?.message ?? e.message));
	}
	const text = await res.text().catch(() => '');
	if (res.status >= 300 && res.status < 400) throw new DeliveryError(`HTTP ${res.status}: redirected to ${res.headers.get('location') ?? 'elsewhere'} (use the final URL)`, res.status);
	if (!res.ok) {
		const detail = errorDetail(text);
		throw new DeliveryError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
	}
	return text;
}

export const jsonHeaders = { 'content-type': 'application/json', 'user-agent': 'octo-modern' };

export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function imageBlob(img: { data: Uint8Array; type: string }): Blob {
	return new Blob([img.data as Uint8Array<ArrayBuffer>], { type: img.type });
}

export function imageName(img: { type: string }): string {
	return `snapshot.${img.type === 'image/png' ? 'png' : img.type === 'image/webp' ? 'webp' : img.type === 'image/gif' ? 'gif' : 'jpg'}`;
}
