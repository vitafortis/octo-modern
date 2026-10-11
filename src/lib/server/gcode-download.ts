/**
 * Raw G-code downloads for the toolpath viewer: an OctoPrint file (local storage) or a
 * library file, streamed through octo·modern with Range support, so the browser never
 * needs OctoPrint's API key or the NAS credentials. Read-only; anyone who may see the
 * printer (or the library source) may preview its files.
 */
import { Readable } from 'node:stream';
import { encodePath, type OctoPrintClient } from './octoprint/client.ts';
import { toOctoPrintError } from './octoprint/errors.ts';
import { openRead, withDriver } from './library/service.ts';
import { LibraryError } from './library/drivers.ts';
import type { LibrarySource } from '#lib/library.ts';

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range `Range: bytes=…` header against a file size. Returns null when
 * there's no (usable) header — serve the whole file — and 'unsatisfiable' for a range
 * past the end (416). Multi-range requests are served whole, which RFC 9110 allows.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
	if (!header) return null;
	const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
	if (!m || (!m[1] && !m[2])) return null;
	if (!m[1]) {
		// Suffix: the last N bytes.
		const n = Number(m[2]);
		if (!n) return 'unsatisfiable';
		return { start: Math.max(0, size - n), end: size - 1 };
	}
	const start = Number(m[1]);
	const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
	if (start >= size || end < start) return 'unsatisfiable';
	return { start, end };
}

const BASE_HEADERS = {
	'content-type': 'text/plain; charset=utf-8',
	'cache-control': 'private, no-store',
	'x-content-type-options': 'nosniff',
	'content-security-policy': "default-src 'none'",
	'accept-ranges': 'bytes'
};

/** Headers for a (partial) file response. */
export function rangeHeaders(size: number, range: ByteRange | null, name: string): Record<string, string> {
	const h: Record<string, string> = { ...BASE_HEADERS, 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}` };
	if (range) {
		h['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
		h['content-length'] = String(range.end - range.start + 1);
	} else h['content-length'] = String(size);
	return h;
}

const unsatisfiable = (size: number) => new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });

/**
 * An OctoPrint local file, passing the Range header through (OctoPrint's download
 * handler supports ranges). Aborts the upstream request when the browser goes away.
 */
export async function octoprintDownload(client: OctoPrintClient, path: string, range: string | null, signal: AbortSignal): Promise<Response> {
	const headers: Record<string, string> = { accept: '*/*' };
	if (range) headers.range = range;
	let res: Response;
	try {
		res = await client.request('GET', `/downloads/files/local/${encodePath(path)}`, { headers, allow: [206, 404, 416], timeoutMs: 60 * 60_000, signal });
	} catch (err) {
		throw toOctoPrintError(err, client.host);
	}
	if (res.status === 404) {
		await res.body?.cancel().catch(() => {});
		return Response.json({ message: 'File not found on OctoPrint', code: 'NOT_FOUND' }, { status: 404 });
	}
	const out: Record<string, string> = { ...BASE_HEADERS };
	for (const k of ['content-length', 'content-range', 'last-modified', 'etag']) {
		const v = res.headers.get(k);
		if (v) out[k] = v;
	}
	if (res.status === 416) {
		await res.body?.cancel().catch(() => {});
		return new Response(null, { status: 416, headers: out });
	}
	if (!res.headers.get('accept-ranges') && res.status !== 206) delete out['accept-ranges'];
	return new Response(res.body, { status: res.status, headers: out });
}

/** A library file, with Range support from the source driver. */
export async function libraryDownload(src: LibrarySource, path: string, rangeHeader: string | null, name: string): Promise<Response> {
	const st = await withDriver(src, (d) => d.stat(path));
	if (st.type !== 'file') throw new LibraryError('Not a file', { status: 400, code: 'NOT_A_FILE' });
	const range = parseRange(rangeHeader, st.size);
	if (range === 'unsatisfiable') return unsatisfiable(st.size);
	if (st.size === 0) return new Response('', { headers: rangeHeaders(0, null, name) });
	const stream = await openRead(src, path, range ?? undefined);
	return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers: rangeHeaders(st.size, range, name) });
}
