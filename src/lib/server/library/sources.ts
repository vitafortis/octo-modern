/**
 * Library sources: where G-code lives (a folder in the container, an SMB share, an SFTP
 * server or a WebDAV folder). Credentials are sealed with the master key, bound to the
 * source id, and never sent to the browser.
 */
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { decrypt, encrypt } from '../crypto.ts';
import { sqlite } from '../store.ts';
import { BadRequest } from '../http.ts';
import { SOURCE_KINDS, type LibrarySource, type SourceConfig, type SourceKind, type SourceOptions, type SourceSecrets } from '#lib/library.ts';

type Row = Record<string, unknown>;

/** What an admin submits: kind, config, options, and secrets (undefined = keep the stored ones). */
export interface SourceInput extends SourceOptions {
	source: SourceConfig;
	secrets: SourceSecrets | undefined;
}

// --- validation ------------------------------------------------------------------------

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function host(v: unknown): string {
	const h = str(v, 255);
	if (!h) throw new BadRequest('Enter the host name or IP address');
	if (!/^[A-Za-z0-9._:[\]-]+$/.test(h)) throw new BadRequest('The host may only contain letters, digits, dots, dashes and colons');
	return h;
}

function port(v: unknown, fallback: number): number {
	if (v === undefined || v === null || v === '') return fallback;
	const n = Number(v);
	if (!Number.isInteger(n) || n < 1 || n > 65535) throw new BadRequest('The port must be 1–65535');
	return n;
}

/** A folder on a remote server: forward slashes, no `..`. */
function remoteDir(v: unknown): string {
	const p = str(v, 1024).replace(/\\/g, '/').replace(/\/+$/, '');
	if (p.split('/').includes('..')) throw new BadRequest('The folder may not contain ..');
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1f]/.test(p)) throw new BadRequest('The folder has invalid characters');
	return p;
}

/** Validates the kind-specific part of a source. */
export function parseSourceConfig(kind: unknown, raw: unknown): SourceConfig {
	if (!SOURCE_KINDS.includes(kind as SourceKind)) throw new BadRequest(`"kind" must be one of ${SOURCE_KINDS.join(', ')}`);
	const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	switch (kind as SourceKind) {
		case 'folder': {
			const path = str(c.path, 1024).replace(/\/+$/, '') || '/';
			if (!isAbsolute(path) || !path.startsWith('/')) throw new BadRequest('The folder must be an absolute path inside the container, e.g. /library');
			if (path.split('/').includes('..')) throw new BadRequest('The folder may not contain ..');
			return { kind: 'folder', config: { path } };
		}
		case 'smb': {
			let share = str(c.share, 120).replace(/^[\\/]+|[\\/]+$/g, '');
			// Accept "share/sub/folder" in the share field too.
			let path = remoteDir(c.path).replace(/^\/+/, '');
			if (share.includes('/') || share.includes('\\')) {
				const parts = share.split(/[\\/]+/);
				share = parts[0];
				path = [parts.slice(1).join('/'), path].filter(Boolean).join('/');
			}
			if (!share) throw new BadRequest('Enter the share name (e.g. prints)');
			if (/[<>:"|?*]/.test(share)) throw new BadRequest('That share name has invalid characters');
			const user = str(c.user, 120);
			if (!user) throw new BadRequest('Enter the user name (SMB needs an account; guest access isn’t supported)');
			return { kind: 'smb', config: { host: host(c.host), port: port(c.port, 445), share, path, domain: str(c.domain, 120), user } };
		}
		case 'sftp': {
			const user = str(c.user, 120);
			if (!user) throw new BadRequest('Enter the user name');
			const hostKey = str(c.hostKey, 200);
			if (hostKey && !/^SHA256:[A-Za-z0-9+/]{20,}=*$/.test(hostKey)) throw new BadRequest('The host key must look like SHA256:… (as ssh-keygen -lf prints it)');
			return { kind: 'sftp', config: { host: host(c.host), port: port(c.port, 22), user, path: remoteDir(c.path), hostKey } };
		}
		case 'webdav': {
			let url: URL;
			try {
				url = new URL(str(c.url, 2000));
			} catch {
				throw new BadRequest('Enter the WebDAV folder URL, e.g. https://cloud.example.com/remote.php/dav/files/me/Prints');
			}
			if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadRequest('The WebDAV URL must start with http:// or https://');
			if (url.username || url.password) throw new BadRequest('Leave credentials out of the URL; use the user and password fields');
			url.hash = '';
			url.search = '';
			const href = url.href.endsWith('/') ? url.href : `${url.href}/`;
			return { kind: 'webdav', config: { url: href, user: str(c.user, 200), verifyTls: c.verifyTls !== false } };
		}
	}
}

/** Validates a whole source form. `requireSecrets` is for new sources of kinds that need a password or key. */
export function parseSourceInput(b: Record<string, unknown>, opts: { existing?: LibrarySource } = {}): SourceInput {
	const source = parseSourceConfig(b.kind, b.config);
	const name = str(b.name, 80) || (source.kind === 'folder' ? source.config.path : source.kind === 'webdav' ? new URL(source.config.url).host : source.config.host);
	let printers: 'all' | string[] = 'all';
	if (Array.isArray(b.printers)) {
		printers = [...new Set(b.printers.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 100))];
	} else if (b.printers !== undefined && b.printers !== 'all') throw new BadRequest('"printers" must be "all" or a list of printer ids');

	let secrets: SourceSecrets | undefined;
	if (b.secrets && typeof b.secrets === 'object') {
		const s = b.secrets as Record<string, unknown>;
		const keep = (k: keyof SourceSecrets) => (typeof s[k] === 'string' ? (s[k] as string) : undefined);
		secrets = { password: keep('password'), privateKey: keep('privateKey')?.trim() || undefined, passphrase: keep('passphrase') };
		if (secrets.privateKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secrets.privateKey)) throw new BadRequest('The private key must be in PEM/OpenSSH format (-----BEGIN … PRIVATE KEY-----)');
		if (source.kind !== 'sftp') secrets = { password: secrets.password };
	}
	const sameKind = opts.existing && opts.existing.kind === source.kind;
	if (source.kind === 'sftp') {
		const hasAny = !!(secrets?.password || secrets?.privateKey) || !!(sameKind && (opts.existing!.hasPassword || opts.existing!.hasPrivateKey));
		if (!hasAny) throw new BadRequest('Set a password or a private key');
	}
	if (source.kind === 'smb') {
		const has = !!secrets?.password || !!(sameKind && opts.existing!.hasPassword);
		if (!has) throw new BadRequest('Set the password');
	}
	// A different kind can't reuse the old secrets.
	if (!secrets && opts.existing && !sameKind) secrets = {};
	return { name, writable: b.writable === true, printers, source, secrets };
}

// --- storage ----------------------------------------------------------------------------

const context = (id: string) => `library:${id}`;

export function sealSecrets(id: string, s: SourceSecrets | undefined): string | null {
	if (!s || !(s.password || s.privateKey || s.passphrase)) return null;
	return encrypt(JSON.stringify(s), context(id));
}

function toSource(r: Row): LibrarySource {
	const secrets = r.secret ? (JSON.parse(decrypt(r.secret as string, context(r.id as string))) as SourceSecrets) : {};
	let printers: 'all' | string[] = 'all';
	try {
		const p = JSON.parse(r.printers as string);
		if (Array.isArray(p)) printers = p;
	} catch {}
	return {
		id: r.id as string,
		name: r.name as string,
		kind: r.kind as SourceKind,
		config: JSON.parse(r.config as string),
		writable: r.writable === 1,
		printers,
		hasPassword: !!secrets.password,
		hasPrivateKey: !!secrets.privateKey,
		hasPassphrase: !!secrets.passphrase,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string
	} as LibrarySource;
}

export function listSources(): LibrarySource[] {
	return (sqlite().prepare('SELECT * FROM library_sources ORDER BY sort, name COLLATE NOCASE').all() as Row[]).map(toSource);
}

export function getSource(id: string): LibrarySource | undefined {
	const row = sqlite().prepare('SELECT * FROM library_sources WHERE id = ?').get(id) as Row | undefined;
	return row && toSource(row);
}

/** The decrypted credentials; never leave the server. */
export function getSourceSecrets(id: string): SourceSecrets {
	const row = sqlite().prepare('SELECT secret FROM library_sources WHERE id = ?').get(id) as Row | undefined;
	return row?.secret ? (JSON.parse(decrypt(row.secret as string, context(id))) as SourceSecrets) : {};
}

export function createSource(input: SourceInput): LibrarySource {
	const id = randomUUID();
	const now = new Date().toISOString();
	const sort = (sqlite().prepare('SELECT coalesce(max(sort), 0) + 1 AS n FROM library_sources').get() as { n: number }).n;
	sqlite()
		.prepare(
			`INSERT INTO library_sources (id, name, kind, config, secret, writable, printers, sort, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, input.name, input.source.kind, JSON.stringify(input.source.config), sealSecrets(id, input.secrets), input.writable ? 1 : 0, JSON.stringify(input.printers), sort, now, now);
	return getSource(id)!;
}

export function updateSource(id: string, input: SourceInput): LibrarySource | undefined {
	const existing = getSource(id);
	if (!existing) return undefined;
	sqlite()
		.prepare('UPDATE library_sources SET name = ?, kind = ?, config = ?, writable = ?, printers = ?, updated_at = ? WHERE id = ?')
		.run(input.name, input.source.kind, JSON.stringify(input.source.config), input.writable ? 1 : 0, JSON.stringify(input.printers), new Date().toISOString(), id);
	if (input.secrets !== undefined) {
		// Fields left empty keep their stored value; send null-ish "clear" via an explicit empty object on kind change.
		const merged: SourceSecrets = Object.keys(input.secrets).length ? { ...(existing.kind === input.source.kind ? getSourceSecrets(id) : {}), ...stripEmpty(input.secrets) } : {};
		sqlite().prepare('UPDATE library_sources SET secret = ? WHERE id = ?').run(sealSecrets(id, merged), id);
	}
	// Anything cached may be stale now (different server or folder).
	if (JSON.stringify(existing.config) !== JSON.stringify(input.source.config) || existing.kind !== input.source.kind) clearMeta(id);
	return getSource(id);
}

function stripEmpty(s: SourceSecrets): SourceSecrets {
	const out: SourceSecrets = {};
	for (const [k, v] of Object.entries(s)) if (typeof v === 'string' && v !== '') out[k as keyof SourceSecrets] = v;
	return out;
}

export function deleteSource(id: string): boolean {
	return Number(sqlite().prepare('DELETE FROM library_sources WHERE id = ?').run(id).changes) > 0;
}

// --- metadata cache ---------------------------------------------------------------------

export interface CachedMeta {
	meta: string;
	thumb: Uint8Array | null;
	thumbType: string | null;
}

/** Cached metadata for a file, if it was parsed at exactly this version (size + mtime). */
export function getMeta(sourceId: string, path: string, version: string): CachedMeta | undefined {
	const row = sqlite().prepare('SELECT meta, thumb, thumb_type FROM library_meta WHERE source_id = ? AND path = ? AND version = ?').get(sourceId, path, version) as Row | undefined;
	return row ? { meta: row.meta as string, thumb: (row.thumb as Uint8Array) ?? null, thumbType: (row.thumb_type as string) ?? null } : undefined;
}

/** Cached metadata (without thumbnails) for many files of one folder at once. */
export function getMetaMany(sourceId: string, items: { path: string; version: string }[]): Map<string, string> {
	const out = new Map<string, string>();
	if (!items.length) return out;
	const stmt = sqlite().prepare('SELECT meta FROM library_meta WHERE source_id = ? AND path = ? AND version = ?');
	for (const it of items) {
		const row = stmt.get(sourceId, it.path, it.version) as Row | undefined;
		if (row) out.set(it.path, row.meta as string);
	}
	return out;
}

const MAX_CACHED = 5000;

export function putMeta(sourceId: string, path: string, version: string, meta: unknown, thumb: Buffer | null, thumbType: string | null) {
	const h = sqlite();
	h.prepare(
		`INSERT INTO library_meta (source_id, path, version, meta, thumb, thumb_type, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(source_id, path) DO UPDATE SET version = excluded.version, meta = excluded.meta, thumb = excluded.thumb, thumb_type = excluded.thumb_type, parsed_at = excluded.parsed_at`
	).run(sourceId, path, version, JSON.stringify(meta), thumb, thumbType, Date.now());
	h.prepare(`DELETE FROM library_meta WHERE rowid IN (SELECT rowid FROM library_meta ORDER BY parsed_at DESC LIMIT -1 OFFSET ?)`).run(MAX_CACHED);
}

export function clearMeta(sourceId: string) {
	sqlite().prepare('DELETE FROM library_meta WHERE source_id = ?').run(sourceId);
}
