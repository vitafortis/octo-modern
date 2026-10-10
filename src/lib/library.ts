/**
 * The Library: G-code kept on a NAS (a mounted folder, SMB, SFTP or WebDAV) that can be
 * sent to any printer. Types and pure helpers shared by the server, the browser and the
 * tests (no server-only imports).
 */

export type SourceKind = 'folder' | 'smb' | 'sftp' | 'webdav';

export const SOURCE_KINDS: SourceKind[] = ['folder', 'smb', 'sftp', 'webdav'];

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
	folder: 'Folder',
	smb: 'SMB share',
	sftp: 'SFTP',
	webdav: 'WebDAV'
};

export interface FolderConfig {
	/** Absolute path inside the container, e.g. /library (an NFS or SMB volume). */
	path: string;
}

export interface SmbConfig {
	host: string;
	port: number;
	/** Share name, e.g. `prints`. */
	share: string;
	/** Folder inside the share; empty for the share's top level. */
	path: string;
	/** NTLM domain or workgroup; usually empty. */
	domain: string;
	user: string;
}

export interface SftpConfig {
	host: string;
	port: number;
	user: string;
	/** Folder on the server; empty for the login folder. */
	path: string;
	/** Optional pinned host key, `SHA256:…`. Empty trusts any key. */
	hostKey: string;
}

export interface WebdavConfig {
	/** Folder URL, e.g. https://cloud.example.com/remote.php/dav/files/me/Prints */
	url: string;
	user: string;
	verifyTls: boolean;
}

export type SourceConfig =
	| { kind: 'folder'; config: FolderConfig }
	| { kind: 'smb'; config: SmbConfig }
	| { kind: 'sftp'; config: SftpConfig }
	| { kind: 'webdav'; config: WebdavConfig };

/** Credentials never leave the server; the browser sees only which are set. */
export interface SourceSecrets {
	password?: string;
	privateKey?: string;
	passphrase?: string;
}

export interface SourceOptions {
	name: string;
	/** octo·modern never writes to the NAS unless this is on ("Save to library"). */
	writable: boolean;
	/** Printers that may print from it: every printer, or the listed ids. */
	printers: 'all' | string[];
}

/** A source as an admin sees it. */
export type LibrarySource = SourceConfig &
	SourceOptions & {
		id: string;
		hasPassword: boolean;
		hasPrivateKey: boolean;
		hasPassphrase: boolean;
		createdAt: string;
		updatedAt: string;
	};

/** A source as everyone else sees it: no addresses or user names. */
export interface LibrarySourceSummary {
	id: string;
	name: string;
	kind: SourceKind;
	writable: boolean;
	/** Printers (among those the user can see) that may print from it. */
	printers: string[];
	/** Where it is, for admins only. */
	location?: string;
}

/** A file or folder in a source. Paths are relative to the source's root, `/`-separated. */
export interface LibraryEntry {
	name: string;
	path: string;
	type: 'folder' | 'file';
	size: number | null;
	/** Modified, epoch milliseconds. */
	mtime: number | null;
	/** Cached slicer metadata, when it has been read before. */
	meta?: GcodeMeta | null;
}

export interface LibraryListing {
	path: string;
	entries: LibraryEntry[];
}

export interface LibrarySearch {
	results: LibraryEntry[];
	/** Stopped early (result, folder or time cap). */
	truncated: boolean;
	scannedFolders: number;
}

/** Slicer metadata from a G-code file's header and footer comments. */
export interface GcodeMeta {
	slicer: string | null;
	slicerVersion: string | null;
	/** Estimated print time, seconds. */
	estimatedTime: number | null;
	/** Filament length, mm (summed over extruders). */
	filamentMm: number | null;
	/** Filament weight, grams (summed). */
	filamentG: number | null;
	filamentType: string | null;
	layerHeight: number | null;
	firstLayerHeight: number | null;
	/** Nozzle diameter, mm. */
	nozzle: number | null;
	nozzleTemp: number | null;
	bedTemp: number | null;
	printerModel: string | null;
	layers: number | null;
	/** The embedded thumbnail, if any (served by the thumbnail route). */
	thumbnail: { width: number; height: number; format: 'png' | 'jpg' } | null;
	/** `binary` for Prusa .bgcode. */
	format: 'text' | 'binary';
}

/** A transfer from a source to a printer. */
export interface LibrarySend {
	id: string;
	sourceId: string;
	sourceName: string;
	path: string;
	printerId: string;
	printerName: string;
	/** OctoPrint folder it goes to ('' = top level). */
	folder: string;
	print: boolean;
	size: number;
	sent: number;
	state: 'sending' | 'processing' | 'done' | 'error' | 'aborted';
	error: string | null;
	/** Stored path on OctoPrint, once done. */
	storedPath: string | null;
	printing: boolean;
	startedAt: string;
	finishedAt: string | null;
	userId: string | null;
}

/** What "printable" means in the library: OctoPrint's machine code (plus UFP, which needs a plugin). */
export const PRINTABLE_EXTENSIONS = ['gcode', 'gco', 'g', 'gc', 'bgcode', 'ufp'];

export function extension(name: string): string {
	const i = name.lastIndexOf('.');
	return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function isPrintable(name: string): boolean {
	return PRINTABLE_EXTENSIONS.includes(extension(name));
}

/** NAS clutter that's never shown: dotfiles, Synology/QNAP/Windows metadata folders. */
export function isHiddenName(name: string): boolean {
	return name.startsWith('.') || name.startsWith('~$') || /^(@eaDir|#recycle|#snapshot|@Recycle|@Recently-Snapshot|\$RECYCLE\.BIN|System Volume Information|Thumbs\.db|desktop\.ini|lost\+found)$/i.test(name);
}

/**
 * A safe relative path: `/`-separated, no empty, `.` or `..` segments, no backslashes
 * or control characters. Leading and trailing slashes are dropped; '' is the root.
 * Throws on anything else.
 */
export function cleanRelPath(raw: unknown): string {
	if (raw == null || raw === '') return '';
	if (typeof raw !== 'string') throw new Error('Path must be a string');
	if (raw.length > 1024) throw new Error('Path too long');
	// eslint-disable-next-line no-control-regex
	if (/[\\\x00-\x1f\x7f]/.test(raw)) throw new Error('Path has invalid characters');
	const parts = raw.split('/').filter((s) => s !== '');
	if (parts.some((s) => s === '.' || s === '..')) throw new Error('Path may not contain . or .. segments');
	return parts.join('/');
}

export function parentPath(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

export function joinPath(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

/** Where a source points, for display (admins). */
export function describeSource(s: SourceConfig): string {
	switch (s.kind) {
		case 'folder':
			return s.config.path;
		case 'smb': {
			const port = s.config.port && s.config.port !== 445 ? `:${s.config.port}` : '';
			return `smb://${s.config.host}${port}/${s.config.share}${s.config.path ? `/${s.config.path.replace(/^\/+/, '')}` : ''}`;
		}
		case 'sftp': {
			const port = s.config.port && s.config.port !== 22 ? `:${s.config.port}` : '';
			return `sftp://${s.config.user}@${s.config.host}${port}/${s.config.path.replace(/^\/+/, '')}`;
		}
		case 'webdav':
			return s.config.url;
	}
}

/** Cache key part that changes whenever the file does. */
export function fileVersion(e: Pick<LibraryEntry, 'size' | 'mtime'>): string {
	return `${e.size ?? 0}-${Math.floor((e.mtime ?? 0) / 1000)}`;
}
