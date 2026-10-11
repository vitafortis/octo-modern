/**
 * Files the queue keeps itself: uploads (from the browser or a slicer) wait in
 * `<data dir>/queue-files/<job id>` until the job is removed, and are streamed to
 * whichever printer takes the job, the same way library sends are (multipart envelope
 * around a file stream, never buffered).
 */
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { PrinterBackend } from '../backend/types.ts';
import { multipartParts } from '../library/send.ts';
import { pullStream } from '../library/drivers.ts';
import { baseName, joinPath } from '#lib/library.ts';

export const stagingDir = () => join(config.dataDir, 'queue-files');

export async function ensureStagingDir(): Promise<string> {
	const dir = stagingDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Where an uploaded job's file lives. Job ids are UUIDs, so this can't escape the folder. */
export const stagedPath = (jobId: string) => join(stagingDir(), jobId.replace(/[^a-zA-Z0-9-]/g, ''));

/** A fresh temporary path for an upload in progress. */
export async function tempUploadPath(): Promise<string> {
	return join(await ensureStagingDir(), `.upload-${randomUUID()}`);
}

export async function stagedSize(jobId: string): Promise<number | null> {
	try {
		return (await stat(stagedPath(jobId))).size;
	} catch {
		return null;
	}
}

export async function removeStaged(jobId: string) {
	await rm(stagedPath(jobId), { force: true }).catch(() => {});
}

/** Removes leftovers of uploads interrupted by a restart. */
export async function cleanTempUploads() {
	const { readdir } = await import('node:fs/promises');
	const dir = stagingDir();
	const names = await readdir(dir).catch(() => [] as string[]);
	for (const n of names) if (n.startsWith('.upload-')) await rm(join(dir, n), { force: true }).catch(() => {});
}

/** The printer's record of a local file: its size, or null when it isn't there. */
export function printerFileSize(backend: PrinterBackend, path: string): Promise<number | null> {
	return backend.fileSize(path);
}

/**
 * Streams a local file into the printer's storage as `folder/name`, optionally
 * selecting and printing it. Resolves with the stored path and whether it prints.
 */
export async function uploadFileToPrinter(
	backend: PrinterBackend,
	opts: { file: string; name: string; folder?: string; select?: boolean; print?: boolean; signal?: AbortSignal }
): Promise<{ path: string; printing: boolean; selected: boolean }> {
	const size = (await stat(opts.file)).size;
	const name = baseName(opts.name) || 'upload.gcode';
	const { head, tail, contentType } = multipartParts(name);
	const stream = createReadStream(opts.file, { highWaterMark: 64 * 1024 });
	async function* body(): AsyncGenerator<Uint8Array> {
		yield head;
		for await (const chunk of stream) yield chunk as Buffer;
		yield tail;
	}
	try {
		const r = await backend.upload({
			body: pullStream(body()),
			contentType,
			length: head.length + size + tail.length,
			folder: opts.folder,
			select: opts.select,
			print: opts.print,
			signal: opts.signal,
			timeoutMs: 5 * 60_000
		});
		return { path: r.path ?? joinPath(opts.folder ?? '', name), printing: r.printing, selected: r.selected };
	} catch (err) {
		stream.destroy();
		throw err;
	}
}
