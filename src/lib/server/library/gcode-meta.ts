/**
 * Slicer metadata from the comments at the top and bottom of a G-code file, read
 * without the middle: PrusaSlicer, SuperSlicer, OrcaSlicer / Bambu Studio, Cura and
 * friends all write a few `; key = value` lines plus base64 thumbnails. Prusa's binary
 * G-code (.bgcode) keeps the same data in metadata and thumbnail blocks at the start.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import type { GcodeMeta } from '#lib/library.ts';

export interface Thumbnail {
	format: 'png' | 'jpg';
	width: number;
	height: number;
	data: Buffer;
}

export interface ParsedGcode {
	meta: GcodeMeta;
	thumbnail: Thumbnail | null;
}

/** Bytes read from each end of a text G-code file. */
export const HEAD_BYTES = 64 * 1024;
export const TAIL_BYTES = 128 * 1024;
/** Upper bound for the head when a big thumbnail runs past HEAD_BYTES (and for .bgcode). */
export const MAX_HEAD_BYTES = 1024 * 1024;
/** Thumbnails bigger than this aren't kept. */
const MAX_THUMBNAIL_BYTES = 1024 * 1024;

const BGCODE_MAGIC = Buffer.from('GCDE');

export function isBgcode(head: Buffer): boolean {
	return head.length >= 4 && head.subarray(0, 4).equals(BGCODE_MAGIC);
}

// --- text G-code -----------------------------------------------------------------

const THUMB_BEGIN = /^;\s*thumbnail(?:_(PNG|JPG|QOI))?\s+begin\s+(\d+)x(\d+)\s+(\d+)/i;
const THUMB_END = /^;\s*thumbnail(?:_(?:PNG|JPG|QOI))?\s+end/i;

/**
 * If the head ends inside a thumbnail block, how many bytes from the start of the file
 * are needed to finish it (an estimate from the block's declared length); otherwise 0.
 */
export function headBytesNeeded(head: Buffer): number {
	const text = head.toString('latin1');
	const re = /^;\s*thumbnail(?:_(?:PNG|JPG|QOI))?\s+begin\s+\d+x\d+\s+(\d+)/gim;
	let need = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const rest = text.slice(m.index);
		if (THUMB_END_ANYWHERE.test(rest)) continue;
		// base64 characters plus "; " and a newline per (usually 78-character) line.
		const chars = Number(m[1]);
		need = Math.max(need, m.index + Math.ceil(chars * 1.06) + 4096);
	}
	return need > head.length ? need : 0;
}
const THUMB_END_ANYWHERE = /^;\s*thumbnail(?:_(?:PNG|JPG|QOI))?\s+end/im;

/** Every `; thumbnail begin` block in the text, decoded (QOI converted to PNG). */
export function extractThumbnails(text: string): Thumbnail[] {
	const out: Thumbnail[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const m = THUMB_BEGIN.exec(lines[i]);
		if (!m) continue;
		const kind = (m[1] ?? 'PNG').toUpperCase();
		const width = Number(m[2]);
		const height = Number(m[3]);
		let b64 = '';
		let ended = false;
		for (i++; i < lines.length; i++) {
			if (THUMB_END.test(lines[i])) {
				ended = true;
				break;
			}
			b64 += lines[i].replace(/^;\s?/, '').trim();
			if (b64.length > MAX_THUMBNAIL_BYTES * 1.4) break;
		}
		if (!ended) continue;
		const thumb = decodeThumbnail(kind, width, height, Buffer.from(b64, 'base64'));
		if (thumb) out.push(thumb);
	}
	return out;
}

function decodeThumbnail(kind: string, width: number, height: number, data: Buffer): Thumbnail | null {
	if (!data.length || data.length > MAX_THUMBNAIL_BYTES || !width || !height) return null;
	if (data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG') return { format: 'png', width, height, data };
	if (data[0] === 0xff && data[1] === 0xd8) return { format: 'jpg', width, height, data };
	if (data.subarray(0, 4).toString('latin1') === 'qoif' || kind === 'QOI') {
		try {
			const img = decodeQoi(data);
			return { format: 'png', width: img.width, height: img.height, data: encodePng(img.width, img.height, img.pixels) };
		} catch {
			return null;
		}
	}
	return null;
}

/** The biggest thumbnail, preferring ones that fit within 512 px. */
export function pickThumbnail(list: Thumbnail[]): Thumbnail | null {
	if (!list.length) return null;
	const area = (t: Thumbnail) => t.width * t.height;
	const fitting = list.filter((t) => t.width <= 512 && t.height <= 512);
	return [...(fitting.length ? fitting : list)].sort((a, b) => area(b) - area(a))[0];
}

/**
 * `; key = value`, `; key: value` and Cura's `;KEY:value` comment lines, with lower-case
 * keys. Later lines win, so the footer (where slicers put totals and their config)
 * overrides the header.
 */
export function commentFields(text: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		if (!raw.startsWith(';')) continue;
		const line = raw.slice(1).trim();
		if (!line || line.length > 2000) continue;
		let m = /^([^=:]{1,80}?)\s*=\s*(.*)$/.exec(line);
		if (!m) m = /^([^=:]{1,80}?)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1].trim().toLowerCase();
		if (key.startsWith('thumbnail')) continue;
		fields.set(key, m[2].trim());
	}
	// Orca/Bambu put two pairs on one line: "; model printing time: 33m 7s; total estimated time: 37m 21s"
	const combined = /;\s*model printing time:\s*([^;\n]+);\s*total estimated time:\s*([^;\n]+)/i.exec(text);
	if (combined) {
		fields.set('model printing time', combined[1].trim());
		fields.set('total estimated time', combined[2].trim());
	}
	return fields;
}

/** "1d 2h 3m 4s", "1h 25m", "37m 21s", "45s" → seconds. */
export function parseDuration(s: string | undefined | null): number | null {
	if (!s) return null;
	const t = s.trim();
	if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
	let total = 0;
	let matched = false;
	for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) {
		matched = true;
		total += Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2].toLowerCase() as 'd' | 'h' | 'm' | 's'];
	}
	return matched ? Math.round(total) : null;
}

/** The sum of a comma/semicolon separated list of numbers ("123.4, 5.6"); null if none. */
function sumList(s: string | undefined): number | null {
	if (s == null) return null;
	const nums = s
		.split(/[,;]/)
		.map((x) => parseFloat(x.replace(/[^\d.eE+-]/g, '')))
		.filter((n) => Number.isFinite(n));
	return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

/** The first number of a list ("0.4,0.4" → 0.4). */
function firstNum(s: string | undefined): number | null {
	if (s == null) return null;
	const m = /-?\d+(?:\.\d+)?/.exec(s);
	return m ? Number(m[0]) : null;
}

function firstItem(s: string | undefined): string | null {
	if (!s) return null;
	const v = s
		.split(/[;,]/)[0]
		.trim()
		.replace(/^"|"$/g, '');
	return v || null;
}

const pick = (f: Map<string, string>, ...keys: string[]) => {
	for (const k of keys) {
		const v = f.get(k);
		if (v != null && v !== '') return v;
	}
	return undefined;
};

/** Which slicer wrote it, and its version. */
export function detectSlicer(text: string, f: Map<string, string>): { slicer: string | null; version: string | null } {
	const gen = /generated by\s+([A-Za-z][\w.-]*?)\s+v?(\d[\w.+-]*)/i.exec(text) ?? /generated with\s+([A-Za-z][\w.-]*?)\s+v?(\d[\w.+-]*)/i.exec(text);
	let slicer = gen?.[1] ?? null;
	let version = gen?.[2] ?? null;
	if (!slicer && f.get('generator.name')) {
		slicer = f.get('generator.name')!;
		version = f.get('generator.version') ?? null;
	}
	if (!slicer) {
		const other = /^;\s*(Sliced by|Simplify3D\(R\) Version|Sliced with|KISSlicer)\s*([\w.-]+)?\s*(\d[\w.-]*)?/im.exec(text);
		if (other) {
			slicer = other[1] === 'Simplify3D(R) Version' ? 'Simplify3D' : (other[2] ?? other[1]);
			version = other[1] === 'Simplify3D(R) Version' ? (other[2] ?? null) : (other[3] ?? null);
		}
	}
	if (slicer && /^cura/i.test(slicer)) slicer = 'Cura';
	if (version) version = version.replace(/\+.*$/, '');
	return { slicer, version };
}

/** Metadata from the comment fields of text G-code (head and tail joined). */
export function metaFromText(text: string): GcodeMeta {
	const f = commentFields(text);
	const { slicer, version } = detectSlicer(text, f);
	const estimatedTime = parseDuration(
		pick(f, 'estimated printing time (normal mode)', 'estimated printing time', 'total estimated time', 'estimated printing time (silent mode)', 'time', 'print.time', 'print time', 'build time')
	);
	let filamentMm = sumList(pick(f, 'filament used [mm]', 'filament used(mm)'));
	if (filamentMm == null) {
		// Cura: "Filament used: 1.81262m" (metres, per extruder).
		const cura = pick(f, 'filament used');
		if (cura && /m\b/.test(cura)) filamentMm = (sumList(cura.replace(/m\b/g, '')) ?? 0) * 1000 || null;
	}
	if (filamentMm == null) {
		const vol = sumList(pick(f, 'extruder_train.0.material.volume_used'));
		// Cura Griffin reports mm³; at 1.75 mm that's mm / 2.405.
		if (vol != null) filamentMm = Math.round((vol / (Math.PI * 0.875 * 0.875)) * 10) / 10;
	}
	const filamentG = firstNum(pick(f, 'total filament used [g]', 'total filament weight [g]')) ?? sumList(pick(f, 'filament used [g]', 'filament used(g)'));
	const layers = firstNum(pick(f, 'total layer number', 'total layers count', 'layer_count', 'layer count'));
	return {
		slicer,
		slicerVersion: version,
		estimatedTime,
		filamentMm: filamentMm != null ? Math.round(filamentMm * 10) / 10 : null,
		filamentG: filamentG != null ? Math.round(filamentG * 100) / 100 : null,
		filamentType: firstItem(pick(f, 'filament_type', 'filament type', 'extruder_train.0.material.type')),
		layerHeight: firstNum(pick(f, 'layer_height', 'layer height', 'layerheight')),
		firstLayerHeight: firstNum(pick(f, 'first_layer_height', 'initial_layer_print_height', 'layer_height_0')),
		nozzle: firstNum(pick(f, 'nozzle_diameter', 'extruder_train.0.nozzle.diameter', 'nozzle diameter')),
		nozzleTemp: firstNum(pick(f, 'temperature', 'nozzle_temperature', 'extruder_train.0.initial_temperature', 'first_layer_temperature')),
		bedTemp: firstNum(pick(f, 'bed_temperature', 'hot_plate_temp', 'build_plate.initial_temperature', 'first_layer_bed_temperature')),
		printerModel: firstItem(pick(f, 'printer_model', 'target_machine.name', 'printer_settings_id', 'machine_name')),
		layers: layers != null ? Math.round(layers) : null,
		thumbnail: null,
		format: 'text'
	};
}

/** Parses text G-code from its head and tail (which may overlap or be the same buffer). */
export function parseTextGcode(head: Buffer, tail: Buffer | null): ParsedGcode {
	const headText = head.toString('utf8');
	const text = tail && tail !== head ? `${headText}\n${tail.toString('utf8')}` : headText;
	const meta = metaFromText(text);
	const thumbnail = pickThumbnail(extractThumbnails(headText).concat(tail && tail !== head ? extractThumbnails(tail.toString('utf8')) : []));
	if (thumbnail) meta.thumbnail = { width: thumbnail.width, height: thumbnail.height, format: thumbnail.format };
	return { meta, thumbnail };
}

// --- binary G-code (.bgcode) --------------------------------------------------------

const BLOCK = { fileMetadata: 0, gcode: 1, slicerMetadata: 2, printerMetadata: 3, printMetadata: 4, thumbnail: 5 } as const;

/**
 * Walks the blocks of a Prusa binary G-code file up to the first G-code block (where
 * the metadata ends), as far as `buf` reaches. Metadata blocks may be stored plain or
 * deflated; heatshrink-compressed ones are skipped.
 */
export function parseBgcode(buf: Buffer): ParsedGcode {
	if (!isBgcode(buf)) throw new Error('Not a binary G-code file');
	const checksumType = buf.readUInt16LE(8);
	const checksumSize = checksumType === 1 ? 4 : 0;
	let off = 10;
	const ini: string[] = [];
	const thumbs: Thumbnail[] = [];
	while (off + 8 <= buf.length) {
		const type = buf.readUInt16LE(off);
		const compression = buf.readUInt16LE(off + 2);
		const size = buf.readUInt32LE(off + 4);
		const headerSize = compression ? 12 : 8;
		if (off + headerSize > buf.length) break;
		const stored = compression ? buf.readUInt32LE(off + 8) : size;
		if (type === BLOCK.gcode || type > BLOCK.thumbnail) break;
		const paramsSize = type === BLOCK.thumbnail ? 6 : 2;
		const paramsAt = off + headerSize;
		const dataAt = paramsAt + paramsSize;
		const end = dataAt + stored;
		if (end > buf.length) break;
		const raw = buf.subarray(dataAt, end);
		if (type === BLOCK.thumbnail) {
			const fmt = buf.readUInt16LE(paramsAt);
			const width = buf.readUInt16LE(paramsAt + 2);
			const height = buf.readUInt16LE(paramsAt + 4);
			const t = compression === 0 ? decodeThumbnail(['PNG', 'JPG', 'QOI'][fmt] ?? '', width, height, Buffer.from(raw)) : null;
			if (t) thumbs.push(t);
		} else {
			let data: Buffer | null = null;
			if (compression === 0) data = raw;
			else if (compression === 1) {
				try {
					data = inflateSync(raw);
				} catch {}
			}
			if (data) ini.push(data.toString('utf8'));
		}
		off = end + checksumSize;
	}
	// The INI lines look like comments once prefixed, so the text parser handles them.
	const text = ini
		.join('\n')
		.split(/\r?\n/)
		.map((l) => `; ${l}`)
		.join('\n');
	const meta = metaFromText(text);
	const producer = /^;\s*Producer\s*=\s*([A-Za-z][\w-]*)\s+v?(\d[\w.+-]*)/im.exec(text);
	if (producer) {
		meta.slicer = producer[1];
		meta.slicerVersion = producer[2].replace(/\+.*$/, '');
	}
	meta.format = 'binary';
	const thumbnail = pickThumbnail(thumbs);
	if (thumbnail) meta.thumbnail = { width: thumbnail.width, height: thumbnail.height, format: thumbnail.format };
	return { meta, thumbnail };
}

// --- QOI → PNG -----------------------------------------------------------------------

/** Decodes a QOI image (https://qoiformat.org) to RGBA pixels. */
export function decodeQoi(data: Buffer): { width: number; height: number; pixels: Buffer } {
	if (data.subarray(0, 4).toString('latin1') !== 'qoif') throw new Error('Not a QOI image');
	const width = data.readUInt32BE(4);
	const height = data.readUInt32BE(8);
	if (!width || !height || width * height > 4096 * 4096) throw new Error('Bad QOI size');
	const pixels = Buffer.alloc(width * height * 4);
	const index = new Uint8Array(64 * 4);
	let r = 0,
		g = 0,
		b = 0,
		a = 255;
	let p = 14;
	let run = 0;
	const end = data.length - 8;
	for (let px = 0; px < pixels.length; px += 4) {
		if (run > 0) run--;
		else if (p < end) {
			const b1 = data[p++];
			if (b1 === 0xfe) {
				r = data[p++];
				g = data[p++];
				b = data[p++];
			} else if (b1 === 0xff) {
				r = data[p++];
				g = data[p++];
				b = data[p++];
				a = data[p++];
			} else if ((b1 & 0xc0) === 0x00) {
				const i = b1 * 4;
				r = index[i];
				g = index[i + 1];
				b = index[i + 2];
				a = index[i + 3];
			} else if ((b1 & 0xc0) === 0x40) {
				r = (r + ((b1 >> 4) & 3) - 2) & 255;
				g = (g + ((b1 >> 2) & 3) - 2) & 255;
				b = (b + (b1 & 3) - 2) & 255;
			} else if ((b1 & 0xc0) === 0x80) {
				const b2 = data[p++];
				const vg = (b1 & 0x3f) - 32;
				r = (r + vg - 8 + ((b2 >> 4) & 0x0f)) & 255;
				g = (g + vg) & 255;
				b = (b + vg - 8 + (b2 & 0x0f)) & 255;
			} else {
				run = b1 & 0x3f;
			}
			const i = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
			index[i] = r;
			index[i + 1] = g;
			index[i + 2] = b;
			index[i + 3] = a;
		}
		pixels[px] = r;
		pixels[px + 1] = g;
		pixels[px + 2] = b;
		pixels[px + 3] = a;
	}
	return { width, height, pixels };
}

/** A minimal RGBA PNG encoder (no filtering; zlib does the work). */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	const chunk = (type: string, body: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(body.length);
		const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(tb) >>> 0);
		return Buffer.concat([len, tb, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
