/**
 * Read (and, for writable sources, write) access to a library source. Every path is
 * relative to the source's root and has already been through `cleanRelPath`, so it has
 * no `..` segments; the folder driver also resolves symlinks and refuses anything that
 * ends up outside the root.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import SftpClient from 'ssh2-sftp-client';
import { Client as SmbClient } from 'smb3-client';
import { httpFetch, streamRequest } from '../octoprint/transport.ts';
import { OctoPrintError } from '../octoprint/errors.ts';
import { cleanRelPath, type SmbConfig, type SourceConfig, type SourceSecrets, type SftpConfig, type WebdavConfig } from '#lib/library.ts';

export interface Stat {
	type: 'file' | 'folder';
	size: number;
	/** epoch ms */
	mtime: number | null;
}

export interface RawEntry extends Stat {
	name: string;
}

export interface Driver {
	/** Entries of a folder (unfiltered). */
	list(dir: string): Promise<RawEntry[]>;
	stat(path: string): Promise<Stat>;
	/** The file, or bytes `start`–`end` (inclusive) of it. */
	read(path: string, range?: { start: number; end: number }): Promise<Readable>;
	/** Stores `body` at `path` (via a temporary name, then a rename). */
	write(path: string, body: Readable, size: number): Promise<void>;
	close(): Promise<void>;
}

/** A library error with a hint, shaped like OctoPrint errors so API handlers report it the same way. */
export class LibraryError extends OctoPrintError {
	constructor(message: string, opts: ConstructorParameters<typeof OctoPrintError>[1] = {}) {
		super(message, opts);
		this.name = 'LibraryError';
	}
}

export const notFound = (what = 'File') => new LibraryError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });

const HINTS: Record<string, [string, string]> = {
	ENOENT: ['Not found', 'The file or folder doesn’t exist (any more).'],
	EACCES: ['Permission denied', 'The account (or, for a folder, octo·modern’s user, uid 1000) can’t read this. Check the share’s permissions.'],
	EPERM: ['Permission denied', 'The account (or, for a folder, octo·modern’s user, uid 1000) can’t read this. Check the share’s permissions.'],
	ENOTDIR: ['Not a folder', 'Check the root folder of this source.'],
	ENXIO: ['Share not found', 'Check the share name (it’s case-insensitive, without slashes).'],
	ECONNREFUSED: ['Connection refused', 'Is the NAS on, and is the port right? Inside Docker, localhost is octo·modern’s own container.'],
	ENOTFOUND: ['Host not found', 'Check the host name; .local (mDNS) names usually don’t resolve inside containers — use the IP address.'],
	EHOSTUNREACH: ['Host unreachable', 'No route to the NAS from octo·modern.'],
	ETIMEDOUT: ['Timed out', 'The NAS didn’t answer in time.'],
	TIMEOUT: ['Timed out', 'The NAS didn’t answer in time.'],
	ECONNRESET: ['Connection reset', 'The NAS closed the connection.'],
	AUTH: ['Sign-in failed', 'Check the user name and password (or key).'],
	HOSTKEY: ['Host key mismatch', 'The server presented a different host key than the pinned one.']
};

/** Turns fs/SFTP/SMB/HTTP failures into a LibraryError with a hint. */
export function toLibraryError(err: unknown): LibraryError {
	if (err instanceof LibraryError) return err;
	if (err instanceof OctoPrintError) return new LibraryError(err.message, { status: err.status, code: err.code, hint: err.hint });
	const e = err as { code?: unknown; message?: string; name?: string; level?: string; statusName?: string };
	const msg = String(e?.message ?? err);
	let code = typeof e?.code === 'string' ? e.code : typeof e?.code === 'number' && e.code === 2 ? 'ENOENT' : typeof e?.code === 'number' && e.code === 3 ? 'EACCES' : undefined;
	if (!code && /no such file|not found|STATUS_OBJECT_(NAME|PATH)_NOT_FOUND/i.test(msg)) code = 'ENOENT';
	if (!code && /permission denied|STATUS_ACCESS_DENIED/i.test(msg)) code = 'EACCES';
	if (e?.level === 'client-authentication' || e?.name === 'SmbAuthError' || /authentication|LOGON_FAILURE|All configured authentication methods failed/i.test(msg)) code = 'AUTH';
	if (/host key mismatch|hostVerifier|Host denied/i.test(msg)) code = 'HOSTKEY';
	if (/timed out|timeout/i.test(msg) && !code) code = 'TIMEOUT';
	const known = code ? HINTS[code] : undefined;
	const status = code === 'ENOENT' ? 404 : undefined;
	if (known) return new LibraryError(code === 'ENOENT' ? known[0] : `${known[0]}${/^(ENOENT|EACCES|EPERM)$/.test(code!) ? '' : `: ${msg.replace(/^\w+:\s*/, '').slice(0, 160)}`}`, { status, code: code === 'ENOENT' ? 'NOT_FOUND' : code, hint: known[1], cause: err });
	return new LibraryError(msg.slice(0, 300), { code, cause: err });
}

/** Limits a stream to `length` bytes after skipping `skip` (for servers that ignore Range). */
function slice(skip: number, length: number): Transform {
	let pos = 0;
	return new Transform({
		transform(chunk: Buffer, _enc, cb) {
			const start = Math.max(0, skip - pos);
			const end = Math.min(chunk.length, skip + length - pos);
			pos += chunk.length;
			if (end > start) this.push(chunk.subarray(start, end));
			if (pos >= skip + length) {
				this.push(null);
				return;
			}
			cb();
		}
	});
}

/** A web ReadableStream that pulls from an async iterator only as fast as it's read (backpressure). */
export function pullStream(it: AsyncIterator<Uint8Array>): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async pull(ctrl) {
			try {
				const { value, done } = await it.next();
				if (done) ctrl.close();
				else ctrl.enqueue(value);
			} catch (err) {
				ctrl.error(err);
			}
		},
		async cancel() {
			await it.return?.();
		}
	});
}

// --- folder ------------------------------------------------------------------------------

/** True when `child` is `root` or inside it (both already resolved). */
export function within(root: string, child: string): boolean {
	return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function folderDriver(rootPath: string): Driver {
	let rootReal: string | undefined;
	const root = async () => {
		if (rootReal) return rootReal;
		try {
			rootReal = await realpath(rootPath);
		} catch (err) {
			throw toLibraryError(err);
		}
		if (!(await stat(rootReal)).isDirectory()) throw new LibraryError(`${rootPath} is not a folder`, { code: 'ENOTDIR', hint: 'Mount the NAS share there (see the README), or pick another folder.' });
		return rootReal;
	};
	/** The real path of an existing entry, if it's inside the root. */
	const resolveExisting = async (rel: string): Promise<string> => {
		const r = await root();
		const full = join(r, ...cleanRelPath(rel).split('/').filter(Boolean));
		let real: string;
		try {
			real = await realpath(full);
		} catch (err) {
			throw toLibraryError(err);
		}
		if (!within(r, real)) throw new LibraryError('Path escapes the library folder', { status: 403, code: 'OUTSIDE_ROOT', hint: 'A symlink points outside the source’s folder; octo·modern won’t follow it.' });
		return real;
	};
	return {
		async list(dir) {
			const r = await root();
			const real = await resolveExisting(dir);
			const out: RawEntry[] = [];
			let dirents;
			try {
				dirents = await readdir(real, { withFileTypes: true });
			} catch (err) {
				throw toLibraryError(err);
			}
			for (const d of dirents) {
				const full = join(real, d.name);
				try {
					let target = full;
					if (d.isSymbolicLink()) {
						target = await realpath(full);
						if (!within(r, target)) continue; // never show what we wouldn't serve
					}
					const s = await stat(target);
					if (s.isDirectory()) out.push({ name: d.name, type: 'folder', size: 0, mtime: s.mtimeMs });
					else if (s.isFile()) out.push({ name: d.name, type: 'file', size: s.size, mtime: s.mtimeMs });
				} catch {
					// Broken symlink or vanished file: skip.
				}
			}
			return out;
		},
		async stat(path) {
			const real = await resolveExisting(path);
			const s = await stat(real);
			return { type: s.isDirectory() ? 'folder' : 'file', size: s.size, mtime: s.mtimeMs };
		},
		async read(path, range) {
			const real = await resolveExisting(path);
			const s = await stat(real);
			if (!s.isFile()) throw notFound();
			return createReadStream(real, range ? { start: range.start, end: range.end, highWaterMark: 64 * 1024 } : { highWaterMark: 64 * 1024 });
		},
		async write(path, body, _size) {
			const rel = cleanRelPath(path);
			if (!rel) throw new LibraryError('No file name', { status: 400 });
			const r = await root();
			const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
			// Create missing folders, then check the (real) parent is still inside the root.
			await mkdir(join(r, ...parentRel.split('/').filter(Boolean)), { recursive: true }).catch((err) => {
				throw toLibraryError(err);
			});
			const parent = await resolveExisting(parentRel);
			const file = join(parent, rel.slice(rel.lastIndexOf('/') + 1));
			const existing = await lstat(file).catch(() => null);
			if (existing?.isSymbolicLink()) throw new LibraryError('Won’t overwrite a symlink', { status: 409, code: 'SYMLINK' });
			const partial = `${file}.octo-modern-partial`;
			try {
				await pipeline(body, createWriteStream(partial, { mode: 0o644 }));
				await rename(partial, file);
			} catch (err) {
				await rm(partial, { force: true });
				throw toLibraryError(err);
			}
		},
		async close() {}
	};
}

// --- SFTP ------------------------------------------------------------------------------------

/** OpenSSH-style fingerprint: `SHA256:base64-without-padding`. */
export function fingerprint(key: Buffer): string {
	return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export async function sftpConnect(c: SftpConfig, s: SourceSecrets, seen?: { hostKey?: string }): Promise<SftpClient> {
	const client = new SftpClient('octo-modern');
	const pinned = c.hostKey.trim().replace(/=+$/, '');
	try {
		await client.connect({
			host: c.host,
			port: c.port || 22,
			username: c.user,
			password: s.password || undefined,
			privateKey: s.privateKey || undefined,
			passphrase: s.passphrase || undefined,
			readyTimeout: 15_000,
			keepaliveInterval: 15_000,
			hostVerifier: (key: Buffer) => {
				const fp = fingerprint(key);
				if (seen) seen.hostKey = fp;
				return !pinned || fp === pinned;
			}
		});
	} catch (err) {
		await client.end().catch(() => {});
		if (pinned && seen?.hostKey && seen.hostKey !== pinned) throw new LibraryError(`Host key mismatch: the server presented ${seen.hostKey}`, { code: 'HOSTKEY', hint: HINTS.HOSTKEY[1] });
		throw toLibraryError(err);
	}
	return client;
}

function sftpDriver(c: SftpConfig, s: SourceSecrets): Driver {
	let conn: Promise<SftpClient> | null = null;
	const client = () => (conn ??= sftpConnect(c, s).catch((err) => ((conn = null), Promise.reject(err))));
	const remote = (rel: string) => {
		const r = cleanRelPath(rel);
		const base = c.path || '.';
		return r ? posix.join(base, r) : base;
	};
	const run = async <T>(fn: (cl: SftpClient) => Promise<T>): Promise<T> => {
		try {
			return await fn(await client());
		} catch (err) {
			const e = toLibraryError(err);
			// A dropped connection (idle timeout on the server, network): reconnect next time.
			if (e.code !== 'NOT_FOUND' && e.code !== 'EACCES' && e.code !== 'EPERM') {
				const old = conn;
				conn = null;
				void old?.then((cl) => cl.end()).catch(() => {});
			}
			throw e;
		}
	};
	const toStat = (st: { isDirectory: boolean; size: number; modifyTime: number }): Stat => ({ type: st.isDirectory ? 'folder' : 'file', size: st.size, mtime: st.modifyTime });
	return {
		list: (dir) =>
			run(async (cl) => {
				const base = remote(dir);
				const out: RawEntry[] = [];
				for (const e of await cl.list(base)) {
					if (e.type === 'd') out.push({ name: e.name, type: 'folder', size: 0, mtime: e.modifyTime });
					else if (e.type === '-') out.push({ name: e.name, type: 'file', size: e.size, mtime: e.modifyTime });
					else if (e.type === 'l') {
						const st = await cl.stat(posix.join(base, e.name)).catch(() => null);
						if (st && (st.isDirectory || st.isFile)) out.push({ name: e.name, ...toStat(st) });
					}
				}
				return out;
			}),
		stat: (path) => run(async (cl) => toStat(await cl.stat(remote(path)))),
		read: (path, range) =>
			run(async (cl) => {
				const st = await cl.stat(remote(path));
				if (!st.isFile) throw notFound();
				return cl.createReadStream(remote(path), range ? { start: range.start, end: range.end, highWaterMark: 64 * 1024 } : { highWaterMark: 64 * 1024 }) as unknown as Readable;
			}),
		write: (path, body) =>
			run(async (cl) => {
				const file = remote(path);
				const partial = `${file}.octo-modern-partial`;
				try {
					await cl.mkdir(posix.dirname(file), true).catch(() => {});
					await cl.put(body, partial);
					await cl.delete(file, true);
					await cl.rename(partial, file);
				} catch (err) {
					body.destroy();
					await cl.delete(partial, true).catch(() => {});
					throw err;
				}
			}),
		async close() {
			const c2 = conn;
			conn = null;
			if (c2) await (await c2.catch(() => null))?.end().catch(() => {});
		}
	};
}

// --- SMB ------------------------------------------------------------------------------------

function smbDriver(c: SmbConfig, s: SourceSecrets): Driver {
	let conn: Promise<SmbClient> | null = null;
	const connect = async () => {
		const cl = new SmbClient({ host: c.host, port: c.port || 445, domain: c.domain || '', username: c.user, password: s.password ?? '', connectTimeout: 10_000, requestTimeout: 30_000 });
		await cl.connect();
		return cl;
	};
	const client = () => (conn ??= connect().catch((err) => ((conn = null), Promise.reject(err))));
	const dropConnection = () => {
		const old = conn;
		conn = null;
		void old?.then((cl) => cl.close()).catch(() => {});
	};
	const remote = (rel: string) => [c.share, c.path.replace(/^\/+|\/+$/g, ''), cleanRelPath(rel)].filter(Boolean).join('/');
	const run = async <T>(fn: (cl: SmbClient) => Promise<T>): Promise<T> => {
		try {
			return await fn(await client());
		} catch (err) {
			const e = toLibraryError(err);
			// A broken connection: reconnect next time.
			if (e.code !== 'NOT_FOUND' && e.code !== 'EACCES') dropConnection();
			throw e;
		}
	};
	return {
		list: (dir) =>
			run(async (cl) => {
				const entries = (await cl.readdir(remote(dir), { withFileTypes: true })) as unknown as { name: string; size: number; mtime: Date; isDirectory(): boolean }[];
				return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'folder' : 'file', size: e.isDirectory() ? 0 : e.size, mtime: e.mtime?.getTime() ?? null }) as RawEntry);
			}),
		stat: (path) =>
			run(async (cl) => {
				const st = await cl.stat(remote(path));
				return { type: st.isDirectory ? 'folder' : 'file', size: st.size, mtime: st.mtime.getTime() };
			}),
		read: (path, range) =>
			run(async (cl) => {
				const st = await cl.stat(remote(path));
				if (st.isDirectory) throw notFound();
				const stream = cl.createReadStream(remote(path), range ? { start: range.start, end: Math.min(range.end, st.size - 1) } : undefined);
				stream.once('error', (err) => {
					// The connection died mid-transfer: start a fresh one next time.
					if (/connection closed|ECONNRESET|socket/i.test(String((err as Error)?.message))) dropConnection();
				});
				return stream;
			}),
		write: (path, body) =>
			run(async (cl) => {
				const file = remote(path);
				const parts = file.split('/');
				// Create missing folders below the share.
				for (let i = 2; i < parts.length; i++) {
					await cl.mkdir(parts.slice(0, i).join('/')).catch(() => {});
				}
				// Written in place (some servers can't rename over SMB2 on their file system);
				// a failed copy is deleted rather than left half-written.
				try {
					await pipeline(body, cl.createWriteStream(file));
				} catch (err) {
					await cl.rm(file).catch(() => {});
					throw err;
				}
			}),
		async close() {
			const c2 = conn;
			conn = null;
			if (c2) await (await c2.catch(() => null))?.close().catch(() => {});
		}
	};
}

// --- WebDAV ------------------------------------------------------------------------------

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`;

/** Entries of a PROPFIND multistatus answer: href (decoded path), folder flag, size, mtime. */
export function parsePropfind(xml: string): { href: string; folder: boolean; size: number; mtime: number | null }[] {
	const out: { href: string; folder: boolean; size: number; mtime: number | null }[] = [];
	const tag = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');
	for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
		const body = m[1];
		const href = tag('href').exec(body)?.[1]?.trim();
		if (!href) continue;
		// Only the propstat with a 200 status counts.
		const ok = [...body.matchAll(/<(?:[\w-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/gi)].map((p) => p[1]).find((p) => /\s200\s/.test(tag('status').exec(p)?.[1] ?? ' 200 ')) ?? body;
		const folder = /<(?:[\w-]+:)?collection\b/i.test(tag('resourcetype').exec(ok)?.[1] ?? '') || /<(?:[\w-]+:)?resourcetype\b[^>]*>\s*<(?:[\w-]+:)?collection/i.test(ok);
		const size = Number(tag('getcontentlength').exec(ok)?.[1] ?? 0) || 0;
		const lm = tag('getlastmodified').exec(ok)?.[1];
		const mtime = lm ? Date.parse(lm) : NaN;
		let path = href.replace(/&amp;/g, '&');
		try {
			path = decodeURIComponent(new URL(path, 'http://x').pathname);
		} catch {}
		out.push({ href: path, folder, size, mtime: Number.isFinite(mtime) ? mtime : null });
	}
	return out;
}

function webdavDriver(c: WebdavConfig, s: SourceSecrets): Driver {
	const base = new URL(c.url);
	const auth = c.user || s.password ? `Basic ${Buffer.from(`${c.user}:${s.password ?? ''}`).toString('base64')}` : undefined;
	const urlFor = (rel: string, folder = false) => {
		const r = cleanRelPath(rel);
		const enc = r
			.split('/')
			.filter(Boolean)
			.map((x) => encodeURIComponent(x))
			.join('/');
		return new URL(`${enc}${folder && enc ? '/' : ''}`, base).href;
	};
	const headers = (extra: Record<string, string> = {}) => ({ ...(auth ? { authorization: auth } : {}), ...extra });
	const request = async (method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}, allow: number[] = []) => {
		let res: Response;
		try {
			res = await httpFetch(url, { method, headers: headers(init.headers), body: init.body, signal: AbortSignal.timeout(30_000) }, c.verifyTls);
		} catch (err) {
			throw toLibraryError((err as { cause?: unknown }).cause ?? err);
		}
		if (res.ok || allow.includes(res.status)) return res;
		await res.body?.cancel().catch(() => {});
		if (res.status === 404) throw notFound();
		if (res.status === 401 || res.status === 403) throw new LibraryError(res.status === 401 ? 'Sign-in failed' : 'Permission denied', { code: res.status === 401 ? 'AUTH' : 'EACCES', hint: HINTS.AUTH[1] });
		throw new LibraryError(`The WebDAV server answered HTTP ${res.status}`, { code: `HTTP_${res.status}` });
	};
	const propfind = async (rel: string, depth: '0' | '1', folder: boolean) => {
		const res = await request('PROPFIND', urlFor(rel, folder), { headers: { depth, 'content-type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY });
		return parsePropfind(await res.text());
	};
	const norm = (p: string) => p.replace(/\/+$/, '');
	return {
		async list(dir) {
			const self = norm(decodeURIComponent(new URL(urlFor(dir, true)).pathname));
			const out: RawEntry[] = [];
			for (const e of await propfind(dir, '1', true)) {
				const p = norm(e.href);
				if (p === self || !p.startsWith(`${self}/`)) continue;
				const name = p.slice(self.length + 1);
				if (!name || name.includes('/')) continue;
				out.push({ name, type: e.folder ? 'folder' : 'file', size: e.folder ? 0 : e.size, mtime: e.mtime });
			}
			return out;
		},
		async stat(path) {
			const [e] = await propfind(path, '0', false);
			if (!e) throw notFound();
			return { type: e.folder ? 'folder' : 'file', size: e.size, mtime: e.mtime };
		},
		async read(path, range) {
			const res = await request('GET', urlFor(path), { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {} });
			if (!res.body) return Readable.from([]);
			const stream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
			// A server that ignores Range sends the whole file: cut it down here.
			if (range && res.status === 200) return stream.pipe(slice(range.start, range.end - range.start + 1));
			return stream;
		},
		async write(path, body, size) {
			const rel = cleanRelPath(path);
			// MKCOL each missing parent folder (405 = exists).
			const parts = rel.split('/').slice(0, -1);
			for (let i = 1; i <= parts.length; i++) await request('MKCOL', urlFor(parts.slice(0, i).join('/'), true), {}, [405, 301]);
			const url = urlFor(rel);
			let res: { status: number; text: string };
			try {
				res = await streamRequest(url, {
					method: 'PUT',
					headers: { ...headers(), 'content-type': 'application/octet-stream', 'content-length': String(size) },
					body: pullStream(body[Symbol.asyncIterator]()),
					verifyTls: c.verifyTls,
					timeoutMs: 5 * 60_000
				});
			} catch (err) {
				throw toLibraryError(err);
			}
			if (res.status < 200 || res.status >= 300) throw new LibraryError(`The WebDAV server answered HTTP ${res.status}`, { code: `HTTP_${res.status}`, hint: res.status === 401 || res.status === 403 ? HINTS.AUTH[1] : undefined });
		},
		async close() {}
	};
}

// --- factory -------------------------------------------------------------------------------

export function openDriver(src: SourceConfig, secrets: SourceSecrets): Driver {
	switch (src.kind) {
		case 'folder':
			return folderDriver(src.config.path);
		case 'sftp':
			return sftpDriver(src.config, secrets);
		case 'smb':
			return smbDriver(src.config, secrets);
		case 'webdav':
			return webdavDriver(src.config, secrets);
	}
}

/** Reads a whole (small) stream into a buffer, refusing more than `max` bytes. */
export async function readAll(stream: Readable, max: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let n = 0;
	for await (const chunk of stream) {
		const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		n += b.length;
		if (n > max) {
			stream.destroy();
			throw new LibraryError('Read more than expected', { code: 'TOO_LARGE' });
		}
		chunks.push(b);
	}
	return Buffer.concat(chunks);
}

