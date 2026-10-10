/**
 * The library as routes use it: who may see which source, pooled connections, folder
 * listings, recursive search, and slicer metadata read from the ends of each file
 * (cached by source, path, size and mtime).
 */
import type { Readable } from 'node:stream';
import { BadRequest, NotFound } from '../http.ts';
import { canSee } from '../permissions.ts';
import { listPrinters } from '../store.ts';
import { openDriver, readAll, sftpConnect, toLibraryError, LibraryError, type Driver } from './drivers.ts';
import { getMeta, getMetaMany, getSource, getSourceSecrets, listSources, putMeta } from './sources.ts';
import { HEAD_BYTES, MAX_HEAD_BYTES, TAIL_BYTES, headBytesNeeded, isBgcode, parseBgcode, parseTextGcode, type ParsedGcode } from './gcode-meta.ts';
import {
	cleanRelPath,
	describeSource,
	extension,
	fileVersion,
	isHiddenName,
	isPrintable,
	joinPath,
	type GcodeMeta,
	type LibraryEntry,
	type LibraryListing,
	type LibrarySearch,
	type LibrarySource,
	type LibrarySourceSummary,
	type SourceConfig,
	type SourceSecrets
} from '#lib/library.ts';
import type { User } from '#lib/types.ts';

/** A path from a request: relative, no traversal (400 otherwise). */
export function relPath(raw: unknown): string {
	try {
		return cleanRelPath(raw);
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
}

// --- access ------------------------------------------------------------------------------

/** Whether a source may be used with a printer (its printer list). */
export function sourceAllowsPrinter(src: Pick<LibrarySource, 'printers'>, printerId: string): boolean {
	return src.printers === 'all' || src.printers.includes(printerId);
}

/** Admins see every source; others see sources open to every printer, or to one they can see. */
export function canSeeSource(user: User | null, src: LibrarySource): boolean {
	if (!user) return false;
	if (user.role === 'admin' || src.printers === 'all') return true;
	return src.printers.some((id) => canSee(user, { id }));
}

export function summarize(user: User | null, src: LibrarySource): LibrarySourceSummary {
	const visible = listPrinters()
		.filter((p) => canSee(user, p) && sourceAllowsPrinter(src, p.id))
		.map((p) => p.id);
	return {
		id: src.id,
		name: src.name,
		kind: src.kind,
		writable: src.writable,
		printers: visible,
		...(user?.role === 'admin' ? { location: describeSource(src) } : {})
	};
}

export function visibleSources(user: User | null): LibrarySourceSummary[] {
	return listSources()
		.filter((s) => canSeeSource(user, s))
		.map((s) => summarize(user, s));
}

/** The source, if the user may see it (404 otherwise). */
export function requireSource(user: User | null, id: string): LibrarySource {
	const src = getSource(id);
	if (!src || !canSeeSource(user, src)) throw new NotFound('Library source not found');
	return src;
}

// --- connection pool -----------------------------------------------------------------------

const IDLE_MS = 30_000;

interface PoolEntry {
	key: string;
	driver: Driver;
	users: number;
	timer: ReturnType<typeof setTimeout> | null;
}

const pool = new Map<string, PoolEntry>();

const poolKey = (src: LibrarySource) => `${src.id}|${src.updatedAt}`;

function acquire(src: LibrarySource): PoolEntry {
	const key = poolKey(src);
	let entry = pool.get(src.id);
	if (entry && entry.key !== key) {
		// The source was edited: retire the old connection once its users are done.
		const old = entry;
		pool.delete(src.id);
		if (!old.users) void old.driver.close();
		entry = undefined;
	}
	if (!entry) {
		entry = { key, driver: openDriver(src, getSourceSecrets(src.id)), users: 0, timer: null };
		pool.set(src.id, entry);
	}
	if (entry.timer) clearTimeout(entry.timer);
	entry.timer = null;
	entry.users++;
	return entry;
}

function release(src: LibrarySource, entry: PoolEntry) {
	entry.users = Math.max(0, entry.users - 1);
	if (entry.users) return;
	if (pool.get(src.id) !== entry) {
		void entry.driver.close();
		return;
	}
	entry.timer = setTimeout(() => {
		if (entry.users) return;
		pool.delete(src.id);
		void entry.driver.close();
	}, IDLE_MS);
	entry.timer.unref?.();
}

/** Runs `fn` with a (pooled) driver for the source. */
export async function withDriver<T>(src: LibrarySource, fn: (d: Driver) => Promise<T>): Promise<T> {
	const entry = acquire(src);
	try {
		return await fn(entry.driver);
	} catch (err) {
		throw toLibraryError(err);
	} finally {
		release(src, entry);
	}
}

/** Opens a stream from the source; the pooled connection stays in use until the stream closes. */
export async function openRead(src: LibrarySource, path: string, range?: { start: number; end: number }): Promise<Readable> {
	const entry = acquire(src);
	try {
		const stream = await entry.driver.read(path, range);
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			release(src, entry);
		};
		stream.once('close', finish);
		stream.once('end', finish);
		stream.once('error', finish);
		return stream;
	} catch (err) {
		release(src, entry);
		throw toLibraryError(err);
	}
}

/** Closes every pooled connection (tests). */
export async function closeAll() {
	for (const [id, e] of pool) {
		pool.delete(id);
		if (e.timer) clearTimeout(e.timer);
		await e.driver.close();
	}
}

// --- listing and search ---------------------------------------------------------------------

function attachMeta(sourceId: string, entries: LibraryEntry[]): LibraryEntry[] {
	const files = entries.filter((e) => e.type === 'file' && isPrintable(e.name));
	const cached = getMetaMany(
		sourceId,
		files.map((e) => ({ path: e.path, version: fileVersion(e) }))
	);
	for (const e of files) {
		const m = cached.get(e.path);
		e.meta = m ? (JSON.parse(m) as GcodeMeta) : undefined;
	}
	return entries;
}

export async function listFolder(src: LibrarySource, rawPath: unknown): Promise<LibraryListing> {
	const path = relPath(rawPath);
	const raw = await withDriver(src, (d) => d.list(path));
	const entries: LibraryEntry[] = raw
		.filter((e) => !isHiddenName(e.name) && !e.name.endsWith('.octo-modern-partial'))
		.map((e) => ({ name: e.name, path: joinPath(path, e.name), type: e.type, size: e.type === 'file' ? e.size : null, mtime: e.mtime }));
	return { path, entries: attachMeta(src.id, entries) };
}

export const SEARCH_LIMITS = { results: 300, folders: 3000, ms: 15_000 };

/**
 * Searches file names below `from` (breadth first) for every word of `query`.
 * Stops at SEARCH_LIMITS and says so.
 */
export async function searchFolder(src: LibrarySource, rawFrom: unknown, query: string, opts: { all?: boolean; limits?: Partial<typeof SEARCH_LIMITS> } = {}): Promise<LibrarySearch> {
	const limits = { ...SEARCH_LIMITS, ...opts.limits };
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const from = relPath(rawFrom);
	const results: LibraryEntry[] = [];
	const queue = [from];
	const started = Date.now();
	let scanned = 0;
	let truncated = false;
	await withDriver(src, async (d) => {
		while (queue.length) {
			if (scanned >= limits.folders || Date.now() - started > limits.ms) {
				truncated = true;
				break;
			}
			const dir = queue.shift()!;
			scanned++;
			let entries;
			try {
				entries = await d.list(dir);
			} catch (err) {
				if (dir === from) throw err;
				continue; // an unreadable subfolder doesn't end the search
			}
			for (const e of entries) {
				if (isHiddenName(e.name)) continue;
				const path = joinPath(dir, e.name);
				if (e.type === 'folder') queue.push(path);
				const hay = e.name.toLowerCase();
				if (!words.every((w) => hay.includes(w))) continue;
				if (e.type === 'file' && !opts.all && !isPrintable(e.name)) continue;
				results.push({ name: e.name, path, type: e.type, size: e.type === 'file' ? e.size : null, mtime: e.mtime });
				if (results.length >= limits.results) {
					truncated = true;
					queue.length = 0;
					break;
				}
			}
		}
	});
	return { results: attachMeta(src.id, results), truncated, scannedFolders: scanned };
}

// --- metadata -------------------------------------------------------------------------------

/** At most a few files are parsed at once, so a folder of G-code doesn't swamp the NAS. */
let running = 0;
const waiting: (() => void)[] = [];
async function limit<T>(fn: () => Promise<T>): Promise<T> {
	if (running >= 4) await new Promise<void>((r) => waiting.push(r));
	running++;
	try {
		return await fn();
	} finally {
		running--;
		waiting.shift()?.();
	}
}

/** In-flight parses, so concurrent requests for the same file share one read. */
const inflight = new Map<string, Promise<{ meta: GcodeMeta; version: string }>>();

/** Reads just enough of a file for its metadata: the head (more if a thumbnail runs past it) and the tail. */
export async function readMetaFrom(read: (start: number, end: number) => Promise<Buffer>, size: number): Promise<ParsedGcode> {
	if (size <= 0) return parseTextGcode(Buffer.alloc(0), null);
	if (size <= HEAD_BYTES + TAIL_BYTES) {
		const all = await read(0, size - 1);
		return isBgcode(all) ? parseBgcode(all) : parseTextGcode(all, null);
	}
	let head = await read(0, HEAD_BYTES - 1);
	if (isBgcode(head)) {
		// Metadata and thumbnails come before the first G-code block.
		head = await read(0, Math.min(size, MAX_HEAD_BYTES) - 1);
		return parseBgcode(head);
	}
	const need = headBytesNeeded(head);
	if (need) {
		const end = Math.min(size, need, MAX_HEAD_BYTES) - 1;
		if (end >= head.length) head = Buffer.concat([head, await read(head.length, end)]);
	}
	const tailStart = Math.max(head.length, size - TAIL_BYTES);
	const tail = tailStart < size ? await read(tailStart, size - 1) : null;
	return parseTextGcode(head, tail);
}

/** Metadata for one file: from the cache when size and mtime match, else read and cached. */
export async function fileMeta(src: LibrarySource, rawPath: unknown): Promise<{ meta: GcodeMeta; version: string }> {
	const path = relPath(rawPath);
	if (!path) throw new BadRequest('Pick a file');
	const st = await withDriver(src, (d) => d.stat(path));
	if (st.type !== 'file') throw new LibraryError('Not a file', { status: 400, code: 'NOT_A_FILE' });
	const version = fileVersion(st);
	const hit = getMeta(src.id, path, version);
	if (hit) return { meta: JSON.parse(hit.meta) as GcodeMeta, version };
	if (!isPrintable(path) || extension(path) === 'ufp') {
		// Not G-code (or a zip): nothing to read.
		const meta: GcodeMeta = emptyMeta();
		putMeta(src.id, path, version, meta, null, null);
		return { meta, version };
	}
	const key = `${src.id}|${path}|${version}`;
	let p = inflight.get(key);
	if (!p) {
		p = limit(async () => {
			const parsed = await readMetaFrom((start, end) => openRead(src, path, { start, end }).then((s) => readAll(s, end - start + 1 + 1024)), st.size ?? 0);
			const t = parsed.thumbnail;
			putMeta(src.id, path, version, parsed.meta, t ? t.data : null, t ? t.format : null);
			return { meta: parsed.meta, version };
		}).finally(() => inflight.delete(key));
		inflight.set(key, p);
	}
	return p;
}

export function emptyMeta(): GcodeMeta {
	return {
		slicer: null,
		slicerVersion: null,
		estimatedTime: null,
		filamentMm: null,
		filamentG: null,
		filamentType: null,
		layerHeight: null,
		firstLayerHeight: null,
		nozzle: null,
		nozzleTemp: null,
		bedTemp: null,
		printerModel: null,
		layers: null,
		thumbnail: null,
		format: 'text'
	};
}

/** The cached thumbnail for a file (parsing it first if needed). */
export async function fileThumbnail(src: LibrarySource, rawPath: unknown): Promise<{ data: Uint8Array; type: string; version: string } | null> {
	const path = relPath(rawPath);
	const { version } = await fileMeta(src, path);
	const hit = getMeta(src.id, path, version);
	if (!hit?.thumb || !hit.thumbType) return null;
	return { data: hit.thumb, type: hit.thumbType === 'jpg' ? 'image/jpeg' : 'image/png', version };
}

// --- test ---------------------------------------------------------------------------------

export type SourceTest =
	| { ok: true; folders: number; files: number; printable: number; sample: string[]; hostKey?: string; latencyMs: number }
	| { ok: false; error: { message: string; code?: string; hint?: string }; hostKey?: string };

/** Connects with a (possibly unsaved) configuration and lists its root. */
export async function testSource(source: SourceConfig, secrets: SourceSecrets): Promise<SourceTest> {
	const started = performance.now();
	const seen: { hostKey?: string } = {};
	let driver: Driver | undefined;
	try {
		if (source.kind === 'sftp') {
			// Connect once on our own first, to report the host key (for pinning).
			const c = await sftpConnect(source.config, secrets, seen);
			await c.end().catch(() => {});
		}
		driver = openDriver(source, secrets);
		const entries = (await driver.list('')).filter((e) => !isHiddenName(e.name));
		const files = entries.filter((e) => e.type === 'file');
		const printable = files.filter((e) => isPrintable(e.name));
		return {
			ok: true,
			folders: entries.length - files.length,
			files: files.length,
			printable: printable.length,
			sample: [...entries.filter((e) => e.type === 'folder').map((e) => `${e.name}/`), ...printable.map((e) => e.name)].slice(0, 6),
			hostKey: seen.hostKey,
			latencyMs: Math.round(performance.now() - started)
		};
	} catch (err) {
		const e = toLibraryError(err);
		return { ok: false, error: { message: e.message, code: e.code, hint: e.hint }, hostKey: seen.hostKey };
	} finally {
		await driver?.close().catch(() => {});
	}
}
