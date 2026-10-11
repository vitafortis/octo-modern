/**
 * Sending library files to a printer: the file is streamed from the NAS straight into
 * OctoPrint's upload (POST /api/files/local, multipart), never held in memory or on
 * disk here. Transfers run in the background; the browser polls their progress.
 * And the reverse, "Save to library": an OctoPrint file streamed onto a writable source.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { audit } from '../permissions.ts';
import { refreshSoon } from '../control.ts';
import { toOctoPrintError } from '../octoprint/errors.ts';
import type { PrinterBackend } from '../backend/types.ts';
import { prep } from '../preprint/service.ts';
import { prepConfigured } from '../preprint/settings.ts';
import { bytesLabel } from '../octoprint/files-util.ts';
import { LibraryError, pullStream, toLibraryError } from './drivers.ts';
import { openRead, withDriver } from './service.ts';
import { baseName, cleanRelPath, joinPath, type LibrarySend, type LibrarySource } from '#lib/library.ts';
import type { Printer, User } from '#lib/types.ts';

type Locals = { user: User | null; ip?: string };

/** The multipart envelope around a file named `name` (`file` field), and its overhead in bytes. */
export function multipartParts(name: string, boundary = `----octo-modern-${randomBytes(12).toString('hex')}`) {
	const safe = name.replace(/[\r\n"]/g, '_');
	const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8');
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
	return { boundary, head, tail, contentType: `multipart/form-data; boundary=${boundary}` };
}

interface Job {
	send: LibrarySend;
	abort: AbortController;
}

const jobs = new Map<string, Job>();
const KEEP_MS = 15 * 60_000;

function prune() {
	const now = Date.now();
	for (const [id, j] of jobs) if (j.send.finishedAt && now - Date.parse(j.send.finishedAt) > KEEP_MS) jobs.delete(id);
}

export function listSends(user: User | null): LibrarySend[] {
	prune();
	return [...jobs.values()].map((j) => j.send).filter((s) => user?.role === 'admin' || s.userId === user?.id);
}

export function getSend(user: User | null, id: string): LibrarySend | undefined {
	const j = jobs.get(id);
	if (!j || (user?.role !== 'admin' && j.send.userId !== user?.id)) return undefined;
	return j.send;
}

export function abortSend(user: User | null, id: string): boolean {
	const j = jobs.get(id);
	if (!j || (user?.role !== 'admin' && j.send.userId !== user?.id)) return false;
	if (j.send.state === 'sending' || j.send.state === 'processing') j.abort.abort();
	return true;
}

/** Whether the printer already has a file at `path` in local storage. */
export async function printerHas(backend: PrinterBackend, path: string): Promise<boolean> {
	return (await backend.fileSize(path)) != null;
}

/** A clean OctoPrint folder ('' = top level). */
export function cleanFolder(raw: unknown): string {
	return cleanRelPath(typeof raw === 'string' ? raw : '');
}

/**
 * Starts sending `path` from `src` to the printer. Resolves once the transfer has
 * started (with its record); the transfer itself continues in the background.
 */
export async function startSend(
	locals: Locals,
	opts: { src: LibrarySource; path: string; printer: Printer; backend: PrinterBackend; folder: string; print: boolean }
): Promise<LibrarySend> {
	const { src, printer, backend, folder, print } = opts;
	const path = cleanRelPath(opts.path);
	const st = await withDriver(src, (d) => d.stat(path));
	if (st.type !== 'file') throw new LibraryError('Not a file', { status: 400, code: 'NOT_A_FILE' });
	const name = baseName(path);
	const size = st.size;
	const { head, tail, contentType } = multipartParts(name);
	const send: LibrarySend = {
		id: randomUUID(),
		sourceId: src.id,
		sourceName: src.name,
		path,
		printerId: printer.id,
		printerName: printer.name,
		folder,
		print,
		size,
		sent: 0,
		state: 'sending',
		error: null,
		storedPath: null,
		printing: false,
		preparing: false,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		userId: locals.user?.id ?? null
	};
	const abort = new AbortController();
	jobs.set(send.id, { send, abort });
	// Open the file now, so a missing or unreadable file fails the request itself.
	const file = await openRead(src, path).catch((err) => {
		jobs.delete(send.id);
		throw err;
	});
	abort.signal.addEventListener('abort', () => file.destroy());

	async function* body(): AsyncGenerator<Uint8Array> {
		yield head;
		for await (const chunk of file) {
			const b = chunk as Buffer;
			send.sent += b.length;
			if (send.sent >= size) send.state = 'processing'; // OctoPrint stores (and analyses) it now
			yield b;
		}
		if (send.sent !== size) throw new LibraryError(`The file changed while sending (${send.sent} of ${size} bytes)`, { code: 'CHANGED' });
		yield tail;
	}

	const where = `${src.name}: ${path} → ${printer.name}${folder ? ` /${folder}` : ''}`;
	// Pre-print steps set up for the printer: store it, then start it through them.
	const viaPrep = print && prepConfigured(printer);

	void (async () => {
		try {
			let result: Awaited<ReturnType<PrinterBackend['upload']>>;
			try {
				result = await backend.upload({
					body: pullStream(body()),
					contentType,
					length: head.length + size + tail.length,
					folder,
					select: print,
					print: print && !viaPrep,
					signal: abort.signal,
					timeoutMs: 5 * 60_000
				});
			} catch (err) {
				if (abort.signal.aborted) throw new LibraryError('Cancelled', { code: 'ABORTED' });
				throw err instanceof LibraryError ? err : toOctoPrintError(err, backend.host);
			}
			send.storedPath = result.path ?? joinPath(folder, name);
			send.printing = result.printing;
			send.sent = size;
			let note = '';
			if (viaPrep) {
				try {
					const r = await prep.begin({ printer, backend, origin: 'local', path: send.storedPath, how: 'select', locals, via: 'library' });
					send.preparing = r.preparing;
					send.printing = !r.preparing;
				} catch (err) {
					note = `: ${(err as Error).message}`;
				}
			}
			send.state = 'done';
			audit(locals, 'library.send', {
				printer,
				detail: `${where} (${bytesLabel(size)})${print ? (send.preparing ? ', preparing to print' : send.printing ? ', printing' : `, print requested but the printer wasn’t ready${note}`) : ''}`
			});
			if (result.printing) audit(locals, 'job.start', { printer, detail: send.storedPath });
			refreshSoon(printer.id);
		} catch (err) {
			file.destroy();
			const aborted = abort.signal.aborted;
			send.state = aborted ? 'aborted' : 'error';
			const e = aborted ? null : err instanceof LibraryError ? err : toLibraryError(err);
			send.error = aborted ? 'Cancelled' : `${e!.message}${e!.hint ? `. ${e!.hint}` : ''}`;
			audit(locals, 'library.send', { printer, detail: `${where}: ${aborted ? 'cancelled' : `failed: ${e!.message}`}` });
		} finally {
			send.finishedAt = new Date().toISOString();
		}
	})();
	return send;
}

/**
 * Streams a file from OctoPrint's local storage onto a writable source
 * (`folder/name`). Resolves when it's stored.
 */
export async function saveToLibrary(
	locals: Locals,
	opts: { src: LibrarySource; printer: Printer; backend: PrinterBackend; octoPath: string; folder: string; overwrite: boolean; signal?: AbortSignal }
): Promise<{ path: string; size: number } | { exists: string }> {
	const { src, printer, backend } = opts;
	if (!src.writable) throw new LibraryError('This library source is read-only', { status: 403, code: 'READ_ONLY', hint: 'An admin can allow writing in the source’s settings.' });
	const octoPath = cleanRelPath(opts.octoPath);
	const dest = joinPath(cleanRelPath(opts.folder), baseName(octoPath));
	if (!opts.overwrite) {
		const exists = await withDriver(src, (d) => d.stat(dest)).then(
			() => true,
			(err) => {
				if (toLibraryError(err).code === 'NOT_FOUND') return false;
				throw err;
			}
		);
		if (exists) return { exists: dest };
	}
	let res: Response;
	try {
		res = await backend.download(octoPath, { timeoutMs: 60 * 60_000, signal: opts.signal });
	} catch (err) {
		throw toOctoPrintError(err, backend.host);
	}
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new LibraryError(res.status === 404 ? `${octoPath} isn’t on the printer` : `The printer answered HTTP ${res.status}`, { status: res.status === 404 ? 404 : 502, code: res.status === 404 ? 'NOT_FOUND' : 'BAD_RESPONSE' });
	}
	const size = Number(res.headers.get('content-length'));
	if (!res.body || !Number.isFinite(size)) throw new LibraryError('The printer didn’t say how big the file is', { code: 'NO_LENGTH' });
	await withDriver(src, (d) => d.write(dest, Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), size));
	audit(locals, 'library.save', { printer, detail: `${printer.name}: ${octoPath} → ${src.name}: ${dest} (${bytesLabel(size)})` });
	return { path: dest, size };
}
