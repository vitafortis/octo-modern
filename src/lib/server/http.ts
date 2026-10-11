import { isHttpError, isRedirect, json } from '@sveltejs/kit';
import { OctoPrintError, toOctoPrintError } from './octoprint/errors.ts';
import { normalizeBaseUrl } from './octoprint/client.ts';
import { isPrinterKind, type PrinterInput } from '#lib/types.ts';

export class BadRequest extends Error {}
export class NotFound extends Error {}
export class Forbidden extends Error {}

/**
 * Wraps an API handler so thrown errors become JSON responses with useful messages:
 * our own 400/403/404s, and OctoPrint/network failures as 502 with `code` and `hint`
 * (OctoPrint's 409 "printer not ready" stays a 409).
 */
export function handler<E>(fn: (event: E) => Promise<Response> | Response) {
	return async (event: E) => {
		try {
			return await fn(event);
		} catch (err) {
			if (err instanceof Response) return err;
			if (err instanceof NotFound) return json({ message: err.message }, { status: 404 });
			if (err instanceof BadRequest) return json({ message: err.message }, { status: 400 });
			if (err instanceof Forbidden) return json({ message: err.message }, { status: 403 });
			// SvelteKit redirects and errors pass through.
			if (isRedirect(err) || isHttpError(err)) throw err;
			// Library (NAS) errors that are the request's fault keep their 4xx status.
			if (err instanceof OctoPrintError && err.name === 'LibraryError' && err.status && err.status >= 400 && err.status < 500 && err.status !== 401) {
				return json(err.toJSON(), { status: err.status });
			}
			const e = err instanceof OctoPrintError ? err : toOctoPrintError(err);
			if (!(err instanceof OctoPrintError)) console.error('[octo-modern] request failed', err);
			const status = e.status === 409 ? 409 : e.status === 404 && e.code === 'NOT_FOUND' ? 404 : e.code === 'NOT_SUPPORTED' ? 400 : 502;
			return json(e.toJSON(), { status });
		}
	};
}

/** Reads a JSON body, turning malformed input into a 400. */
export async function body(request: Request): Promise<Record<string, unknown>> {
	try {
		const b = await request.json();
		if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
	} catch {}
	throw new BadRequest('Expected a JSON object');
}

export const COLOR_KEYS = ['violet', 'blue', 'cyan', 'green', 'amber', 'orange', 'rose', 'slate'];

/**
 * Validates a server form. `apiKey` is undefined when the stored one should be kept.
 * `kind` must be resolved already ('auto' is detected by the route first); OctoPrint
 * needs a key, Moonraker only when it isn't on a trusted network.
 */
export function parsePrinterInput(b: Record<string, unknown>, { requireKey = false } = {}): PrinterInput {
	if (b.kind !== undefined && !isPrinterKind(b.kind)) throw new BadRequest('"kind" must be "octoprint" or "moonraker"');
	const given = isPrinterKind(b.kind) ? b.kind : undefined;
	const kind = given ?? 'octoprint';
	let baseUrl: string;
	try {
		baseUrl = normalizeBaseUrl(typeof b.baseUrl === 'string' ? b.baseUrl : '');
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : undefined;
	if (requireKey && kind === 'octoprint' && !apiKey) throw new BadRequest('Paste an API key (an Application Key or a user API key)');
	if (apiKey !== undefined && apiKey && !/^[\x21-\x7e]{8,256}$/.test(apiKey)) throw new BadRequest('That API key has unexpected characters');
	let webcamUrl: string | null = null;
	if (typeof b.webcamUrl === 'string' && b.webcamUrl.trim()) {
		const raw = b.webcamUrl.trim();
		if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/')) throw new BadRequest('The webcam URL must be http(s)://… or a path on the OctoPrint host like /webcam/?action=snapshot');
		webcamUrl = raw;
	}
	const fallbackName = (() => {
		try {
			return new URL(baseUrl).hostname;
		} catch {
			return kind === 'moonraker' ? 'Klipper' : 'OctoPrint';
		}
	})();
	const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : fallbackName;
	return {
		name,
		...(given ? { kind: given } : {}),
		baseUrl,
		apiKey: apiKey === undefined ? undefined : apiKey,
		verifyTls: b.verifyTls !== false,
		webcamUrl,
		color: typeof b.color === 'string' && COLOR_KEYS.includes(b.color) ? b.color : 'violet'
	};
}
