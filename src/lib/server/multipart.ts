/**
 * A small streaming multipart/form-data parser for slicer uploads: text fields are
 * collected (small), the one file part is written to disk as it arrives, so a 200 MB
 * G-code file never sits in memory. Handles boundaries split across chunks, a
 * preamble, and fields before or after the file (PrusaSlicer sends `print` and `path`
 * first; Cura sends `select`/`print` first; others put them last).
 */
import { open, rm } from 'node:fs/promises';

export class MultipartError extends Error {}

export interface MultipartFile {
	/** Form field name (`file` for OctoPrint uploads). */
	field: string;
	/** The client's file name (not sanitized). */
	filename: string;
	/** Where it was written. */
	path: string;
	size: number;
	contentType: string | null;
}

export interface MultipartResult {
	fields: Record<string, string>;
	file: MultipartFile | null;
}

/** The boundary of a multipart/form-data content type, or null. */
export function boundaryOf(contentType: string | null | undefined): string | null {
	if (!contentType || !/^multipart\/form-data\b/i.test(contentType.trim())) return null;
	const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
	const b = m ? (m[1] ?? m[2]) : null;
	return b && b.length <= 200 ? b : null;
}

/** Parses `name="…"` and `filename="…"` (and RFC 5987 `filename*=UTF-8''…`) from part headers. */
export function parsePartHeaders(raw: string): { name: string | null; filename: string | null; contentType: string | null } {
	let name: string | null = null;
	let filename: string | null = null;
	let contentType: string | null = null;
	for (const line of raw.split('\r\n')) {
		const i = line.indexOf(':');
		if (i === -1) continue;
		const key = line.slice(0, i).trim().toLowerCase();
		const value = line.slice(i + 1).trim();
		if (key === 'content-type') contentType = value;
		if (key !== 'content-disposition') continue;
		const param = (p: string) => {
			const m = new RegExp(`(?:^|;)\\s*${p}="((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(value) ?? new RegExp(`(?:^|;)\\s*${p}=([^;]*)`, 'i').exec(value);
			return m ? m[1].replace(/\\(.)/g, '$1').trim() : null;
		};
		name = param('name');
		filename = param('filename');
		const star = /(?:^|;)\s*filename\*=([^']*)'[^']*'([^;]*)/i.exec(value);
		if (star) {
			try {
				filename = decodeURIComponent(star[2].trim());
			} catch {}
		}
	}
	return { name, filename, contentType };
}

const MAX_HEADER = 16 * 1024;
const MAX_FIELD = 64 * 1024;
const MAX_FIELDS = 50;

/**
 * Parses a multipart body. The first file part is written to `filePath`; a second
 * file part is an error. On any error the partial file is removed.
 */
export async function parseMultipart(body: AsyncIterable<Uint8Array>, boundary: string, filePath: string, opts: { maxFileBytes?: number } = {}): Promise<MultipartResult> {
	const delimiter = Buffer.from(`\r\n--${boundary}`);
	const fields: Record<string, string> = {};
	let file: MultipartFile | null = null;
	let fh: Awaited<ReturnType<typeof open>> | null = null;
	let fieldCount = 0;

	// Prepend CRLF so the first boundary looks like every other delimiter.
	let buf: Buffer = Buffer.from('\r\n');
	type State = 'preamble' | 'afterBoundary' | 'headers' | 'body' | 'done';
	let state = 'preamble' as State;
	let part: { name: string; filename: string | null; contentType: string | null; chunks: Buffer[]; size: number } | null = null;

	const emit = async (data: Buffer) => {
		if (!part || !data.length) return;
		part.size += data.length;
		if (part.filename !== null && fh) {
			if (opts.maxFileBytes && part.size > opts.maxFileBytes) throw new MultipartError('File too large');
			await fh.write(data);
		} else {
			if (part.size > MAX_FIELD) throw new MultipartError(`Field "${part.name}" is too long`);
			part.chunks.push(data);
		}
	};

	const finishPart = async () => {
		if (!part) return;
		if (part.filename !== null && fh) {
			await fh.close();
			fh = null;
			file = { field: part.name, filename: part.filename, path: filePath, size: part.size, contentType: part.contentType };
		} else if (part.filename === null) {
			if (++fieldCount > MAX_FIELDS) throw new MultipartError('Too many fields');
			fields[part.name] = Buffer.concat(part.chunks).toString('utf8');
		}
		part = null;
	};

	try {
		const step = async (): Promise<boolean> => {
			switch (state) {
				case 'preamble': {
					const i = buf.indexOf(delimiter);
					if (i === -1) {
						if (buf.length > MAX_HEADER) throw new MultipartError('No multipart boundary found');
						return false;
					}
					buf = buf.subarray(i + delimiter.length);
					state = 'afterBoundary';
					return true;
				}
				case 'afterBoundary': {
					if (buf.length < 2) return false;
					if (buf[0] === 0x2d && buf[1] === 0x2d) {
						state = 'done';
						return false;
					}
					// Transport padding (spaces/tabs) may precede the CRLF.
					const nl = buf.indexOf('\r\n');
					if (nl === -1) {
						if (buf.length > 256) throw new MultipartError('Malformed multipart boundary');
						return false;
					}
					buf = buf.subarray(nl + 2);
					state = 'headers';
					return true;
				}
				case 'headers': {
					const end = buf.indexOf('\r\n\r\n');
					if (end === -1) {
						if (buf.length > MAX_HEADER) throw new MultipartError('Part headers too long');
						return false;
					}
					const h = parsePartHeaders(buf.subarray(0, end).toString('utf8'));
					buf = buf.subarray(end + 4);
					if (!h.name) throw new MultipartError('A part has no name');
					if (h.filename !== null) {
						if (file || fh) throw new MultipartError('Only one file per upload');
						fh = await open(filePath, 'w', 0o600);
					}
					part = { name: h.name, filename: h.filename, contentType: h.contentType, chunks: [], size: 0 };
					state = 'body';
					return true;
				}
				case 'body': {
					const i = buf.indexOf(delimiter);
					if (i === -1) {
						// Keep enough to recognise a delimiter split across chunks.
						const keep = delimiter.length - 1;
						if (buf.length > keep) {
							await emit(buf.subarray(0, buf.length - keep));
							buf = buf.subarray(buf.length - keep);
						}
						return false;
					}
					await emit(buf.subarray(0, i));
					buf = buf.subarray(i + delimiter.length);
					await finishPart();
					state = 'afterBoundary';
					return true;
				}
				case 'done':
					return false;
			}
		};

		for await (const chunk of body) {
			buf = buf.length ? Buffer.concat([buf, Buffer.from(chunk)]) : Buffer.from(chunk);
			while (await step());
			if (state === 'done') break;
		}
		if (state !== 'done') throw new MultipartError('The upload ended early');
		return { fields, file };
	} catch (err) {
		const h = fh as Awaited<ReturnType<typeof open>> | null;
		await h?.close().catch(() => {});
		await rm(filePath, { force: true }).catch(() => {});
		throw err instanceof MultipartError ? err : new MultipartError((err as Error).message);
	}
}
