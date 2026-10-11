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
import { encodePath, type OctoPrintClient } from '../octoprint/client.ts';
import { streamRequest } from '../octoprint/transport.ts';
import { httpError, toOctoPrintError } from '../octoprint/errors.ts';
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

/** OctoPrint's record of a local file: its size, or null when it isn't there. */
export async function octoprintFileSize(client: OctoPrintClient, path: string): Promise<number | null> {
	const res = await client.request('GET', `/api/files/local/${encodePath(path)}`, { allow: [404] });
	if (res.status === 404) {
		await res.body?.cancel().catch(() => {});
		return null;
	}
	const j = (await res.json().catch(() => null)) as { size?: unknown } | null;
	return typeof j?.size === 'number' ? j.size : -1;
}

/**
 * Streams a local file into OctoPrint's local storage as `folder/name`, optionally
 * selecting and printing it. Resolves with the stored path and whether it prints.
 */
export async function uploadFileToPrinter(
	client: OctoPrintClient,
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
	const q = new URLSearchParams();
	if (opts.folder) q.set('path', opts.folder);
	if (opts.select || opts.print) q.set('select', 'true');
	if (opts.print) q.set('print', 'true');
	let res: { status: number; text: string };
	try {
		res = await streamRequest(client.url(`/api/files/local${q.size ? `?${q}` : ''}`), {
			method: 'POST',
			headers: { 'X-Api-Key': client.target.apiKey, accept: 'application/json', 'content-type': contentType, 'content-length': String(head.length + size + tail.length) },
			body: pullStream(body()),
			verifyTls: client.target.verifyTls,
			signal: opts.signal,
			timeoutMs: 5 * 60_000
		});
	} catch (err) {
		stream.destroy();
		throw toOctoPrintError(err, client.host);
	}
	if (res.status < 200 || res.status >= 300) throw httpError(res.status, '/api/files/local', res.text);
	const r = (JSON.parse(res.text || '{}') ?? {}) as { effectivePrint?: boolean; effectiveSelect?: boolean; files?: { local?: { path?: string } } };
	return { path: r.files?.local?.path ?? joinPath(opts.folder ?? '', name), printing: !!r.effectivePrint, selected: !!r.effectiveSelect };
}
