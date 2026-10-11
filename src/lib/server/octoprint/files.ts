/**
 * OctoPrint's file listing (/api/files?recursive=true), normalized into FileEntry
 * trees. Analysis results, print history and slicer thumbnails are optional and
 * vary by version and plugins.
 */
import type { FileEntry, FileListing } from '#lib/types.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Thumbnail paths a slicer-thumbnail plugin serves (PrusaSlicer, Cura, …); nothing else is proxied. */
export const THUMBNAIL_PATH = /^plugin\/[A-Za-z0-9_.-]+\/thumbnail\/[^?#]*[^/?#](\?[^#]*)?$/;

export function safeThumbnail(src: unknown): string | null {
	const s = str(src)?.replace(/^\/+/, '');
	if (!s || s.includes('..') || s.includes('\\') || !THUMBNAIL_PATH.test(s)) return null;
	return s;
}

export function parseFileEntry(raw: unknown): FileEntry | null {
	if (!isObj(raw)) return null;
	const name = str(raw.name);
	if (!name) return null;
	const origin = raw.origin === 'sdcard' ? 'sdcard' : 'local';
	const t = str(raw.type);
	const type: FileEntry['type'] = t === 'folder' || t === 'machinecode' || t === 'model' ? t : 'other';
	const analysis = isObj(raw.gcodeAnalysis) ? raw.gcodeAnalysis : null;
	let filamentMm: number | null = null;
	if (analysis && isObj(analysis.filament)) {
		for (const f of Object.values(analysis.filament)) {
			const len = isObj(f) ? num(f.length) : null;
			if (len != null) filamentMm = (filamentMm ?? 0) + len;
		}
	}
	const p = isObj(raw.prints) ? raw.prints : null;
	const last = p && isObj(p.last) ? p.last : null;
	const entry: FileEntry = {
		origin,
		path: str(raw.path) ?? name,
		name,
		display: str(raw.display) ?? name,
		type,
		size: num(raw.size),
		date: num(raw.date),
		estimatedPrintTime: analysis ? num(analysis.estimatedPrintTime) : null,
		filamentMm,
		thumbnail: safeThumbnail(raw.thumbnail),
		prints: p ? { success: num(p.success) ?? 0, failure: num(p.failure) ?? 0, lastSuccess: last && typeof last.success === 'boolean' ? last.success : null, lastDate: last ? num(last.date) : null } : null
	};
	if (type === 'folder') entry.children = Array.isArray(raw.children) ? raw.children.map(parseFileEntry).filter((e): e is FileEntry => !!e) : [];
	return entry;
}

export function parseFileListing(raw: unknown): FileListing {
	const r = isObj(raw) ? raw : {};
	return {
		files: Array.isArray(r.files) ? r.files.map(parseFileEntry).filter((e): e is FileEntry => !!e) : [],
		free: num(r.free),
		total: num(r.total)
	};
}

/** Every entry in a tree, depth first. */
export function flatten(entries: FileEntry[]): FileEntry[] {
	return entries.flatMap((e) => [e, ...(e.children ? flatten(e.children) : [])]);
}

/** File names OctoPrint accepts for printing (plus 3D models for slicing, which we don't offer). */
export const GCODE_EXTENSIONS = ['gcode', 'gco', 'g', 'gc', 'bgcode'];

export function isGcodeName(name: string): boolean {
	const ext = name.toLowerCase().split('.').pop() ?? '';
	return name.includes('.') && GCODE_EXTENSIONS.includes(ext);
}

/** A folder name OctoPrint will accept as-is (no separators or traversal). */
export function validFolderName(name: string): boolean {
	return !!name.trim() && name.length <= 120 && !/[/\\]/.test(name) && name !== '.' && name !== '..';
}

/**
 * The parts of one OctoPrint file entry (/api/files/<origin>/<path>) the history, queue
 * and filament checks use: analysis, slicer thumbnail and the last print's record.
 */
export function parseFileDetails(raw: unknown): import('../backend/types.ts').FileDetails {
	const r = isObj(raw) ? raw : {};
	const analysis = isObj(r.gcodeAnalysis) ? r.gcodeAnalysis : null;
	let filamentMm: number | null = null;
	const perTool: Record<number, number> = {};
	if (analysis && isObj(analysis.filament)) {
		for (const [k, f] of Object.entries(analysis.filament)) {
			const len = isObj(f) ? num(f.length) : null;
			if (len == null) continue;
			filamentMm = (filamentMm ?? 0) + len;
			const m = /^tool(\d+)$/.exec(k);
			if (m && len > 0) perTool[Number(m[1])] = len;
		}
	}
	const prints = isObj(r.prints) ? r.prints : null;
	const l = prints && isObj(prints.last) ? prints.last : null;
	const date = l ? num(l.date) : null;
	return {
		size: num(r.size),
		filamentMm,
		perTool,
		estimatedS: analysis ? num(analysis.estimatedPrintTime) : null,
		thumbnail: safeThumbnail(r.thumbnail),
		last: l && date != null && typeof l.success === 'boolean' ? { date: date * 1000, success: l.success, printTime: num(l.printTime) } : null
	};
}
