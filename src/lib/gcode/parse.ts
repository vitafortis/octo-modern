/**
 * A streaming G-code toolpath parser: feed it the file in chunks of bytes, as they
 * arrive, and it builds compact per-point typed arrays for the WebGL viewer. Pure (no
 * DOM, no I/O), so it runs in a Web Worker and in node tests.
 *
 * Model: a list of points; segment i runs from point i-1 to point i and has the kind
 * `kinds[i]` (a feature type for extrusions, TRAVEL for moves without extrusion). Each
 * point remembers the byte offset of the line that produced it, so OctoPrint's
 * `progress.filepos` maps to a point (and a layer) with a binary search.
 *
 * Understands G0/G1, G2/G3 arcs (I/J or R), G90/G91, M82/M83, G92, G20/G21, layer
 * changes from slicer comments (`;LAYER_CHANGE`, `;LAYER:n`) or, without them, from Z,
 * and feature types from `;TYPE:` / `;FEATURE:` comments (PrusaSlicer, SuperSlicer,
 * OrcaSlicer, Bambu Studio, Cura).
 *
 * Memory is bounded: consecutive travels merge into one, and when the point count
 * passes `maxPoints`, short extrusion segments are merged (decimated) with a growing
 * minimum length until it fits.
 */

/** Feature kinds (index into the palette). */
export const FEATURES = [
	{ id: 'outer-wall', label: 'Outer wall' },
	{ id: 'inner-wall', label: 'Inner wall' },
	{ id: 'overhang', label: 'Overhang wall' },
	{ id: 'infill', label: 'Sparse infill' },
	{ id: 'solid-infill', label: 'Solid infill' },
	{ id: 'top-bottom', label: 'Top / bottom' },
	{ id: 'bridge', label: 'Bridge' },
	{ id: 'gap-fill', label: 'Gap fill' },
	{ id: 'skirt', label: 'Skirt / brim' },
	{ id: 'support', label: 'Support' },
	{ id: 'support-interface', label: 'Support interface' },
	{ id: 'tower', label: 'Prime tower' },
	{ id: 'ironing', label: 'Ironing' },
	{ id: 'custom', label: 'Custom / other' },
	{ id: 'extrusion', label: 'Extrusion' }
] as const;

export type FeatureId = (typeof FEATURES)[number]['id'];
/** Kind of an extrusion when the file has no feature comments. */
export const EXTRUSION = 14;
/** Kind of a travel (non-extruding) move. */
export const TRAVEL = 15;
export const KIND_COUNT = 16;

const kindIndex = (id: FeatureId) => FEATURES.findIndex((f) => f.id === id);

/** Maps a slicer's feature name (the text after `;TYPE:`) to a kind. */
export function featureKind(name: string): number {
	const n = name.trim().toLowerCase();
	if (!n) return kindIndex('custom');
	if (/support/.test(n)) return kindIndex(/interface|roof|floor/.test(n) ? 'support-interface' : 'support');
	if (/overhang/.test(n)) return kindIndex('overhang');
	if (/external perimeter|outer wall|wall-outer|outer-wall/.test(n)) return kindIndex('outer-wall');
	if (/perimeter|inner wall|wall-inner|wall/.test(n)) return kindIndex('inner-wall');
	if (/bridge/.test(n)) return kindIndex('bridge');
	if (/gap/.test(n)) return kindIndex('gap-fill');
	if (/ironing/.test(n)) return kindIndex('ironing');
	if (/top|bottom|^skin$/.test(n)) return kindIndex('top-bottom');
	if (/solid/.test(n)) return kindIndex('solid-infill');
	if (/infill|^fill$/.test(n)) return kindIndex('infill');
	if (/skirt|brim/.test(n)) return kindIndex('skirt');
	if (/tower|wipe/.test(n)) return kindIndex('tower');
	return kindIndex('custom');
}

export interface Toolpath {
	/** x, y, z per point. */
	positions: Float32Array;
	/** Kind of the segment ending at each point. */
	kinds: Uint8Array;
	/** Byte offset of the line that produced each point (files up to 4 GiB). */
	offsets: Uint32Array;
	/** Index of each layer's first point; length = layers + 1 (the last entry is the point count). */
	layerStart: Uint32Array;
	/** Print height of each layer (Z of its first extrusion). */
	layerZ: Float32Array;
	/** Extents of the extrusions (travels can wander off to the purge position). */
	bounds: { min: [number, number, number]; max: [number, number, number] };
	stats: ToolpathStats;
}

export interface ToolpathStats {
	bytes: number;
	lines: number;
	/** Moves that produced a segment, before merging and decimation. */
	moves: number;
	points: number;
	layers: number;
	/** Minimum extrusion segment length after decimation, mm (0 = full detail). */
	minSegment: number;
	/** Kinds that occur, as a bit mask (1 << kind). */
	kindsSeen: number;
	/** Layers came from slicer comments (otherwise from Z changes). */
	layerComments: boolean;
	/** Feature types came from slicer comments. */
	typeComments: boolean;
	/** Total filament extruded, mm. */
	filamentMm: number;
	/** Arc moves seen (interpolated into segments). */
	arcs: number;
}

export interface ParserOptions {
	/** Upper bound on points kept (memory cap); decimates beyond it. */
	maxPoints?: number;
	/** Arc interpolation: maximum chord length, mm. */
	arcChord?: number;
}

/** Z steps smaller than this don't start a layer (Z-based detection; ignores spiral vase creep). */
const MIN_LAYER_STEP = 0.04;

// Character codes.
const NL = 10;
const CR = 13;
const SEMI = 59;
const SPACE = 32;
const TAB = 9;
const PAREN = 40;

/** Growable typed array storage. */
class Store {
	pos: Float32Array;
	kinds: Uint8Array;
	offs: Uint32Array;
	n = 0;
	constructor(cap: number) {
		this.pos = new Float32Array(cap * 3);
		this.kinds = new Uint8Array(cap);
		this.offs = new Uint32Array(cap);
	}
	get cap() {
		return this.kinds.length;
	}
	grow(min: number) {
		let cap = this.cap;
		while (cap < min) cap = Math.ceil(cap * 1.6);
		const p = new Float32Array(cap * 3);
		p.set(this.pos.subarray(0, this.n * 3));
		const k = new Uint8Array(cap);
		k.set(this.kinds.subarray(0, this.n));
		const o = new Uint32Array(cap);
		o.set(this.offs.subarray(0, this.n));
		this.pos = p;
		this.kinds = k;
		this.offs = o;
	}
}

export class GcodeParser {
	private maxPoints: number;
	private arcChord: number;
	private store: Store;
	private layers: number[] = [0];
	private layerZs: number[] = [NaN];
	/** The current layer has at least one extrusion. */
	private layerHasExtrusion = false;
	private lastExtrusionIdx = -1;
	/** A layer comment was seen: the next point starts a new layer. */
	private pendingLayer = false;
	private layerComments = false;
	private typeComments = false;
	private kind = EXTRUSION;
	private kindsSeen = 0;
	private minSeg = 0;
	/** The last point may be overwritten (merging short same-kind segments, or consecutive travels). */
	private soft = false;
	/** Index of the point before the soft run started (anchor for the merge distance). */
	private anchor = -1;

	// Machine state.
	private x = 0;
	private y = 0;
	private z = 0;
	private e = 0;
	private absXYZ = true;
	private absE = true;
	private scale = 1;

	// Stats.
	private bytes = 0;
	private lines = 0;
	private moves = 0;
	private arcs = 0;
	private filament = 0;
	private min: [number, number, number] = [Infinity, Infinity, Infinity];
	private max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

	// Line assembly across chunks.
	private carry: Uint8Array = new Uint8Array(0);
	private lineStart = 0;

	// Parsed words of the current line (NaN = absent).
	private wX = NaN;
	private wY = NaN;
	private wZ = NaN;
	private wE = NaN;
	private wF = NaN;
	private wI = NaN;
	private wJ = NaN;
	private wR = NaN;

	constructor(opts: ParserOptions = {}) {
		this.maxPoints = Math.max(10_000, opts.maxPoints ?? 4_000_000);
		this.arcChord = opts.arcChord ?? 0.5;
		this.store = new Store(Math.min(this.maxPoints, 65_536));
	}

	/** Bytes consumed so far. */
	get consumed() {
		return this.bytes;
	}

	/** Feeds the next chunk of the file. */
	push(chunk: Uint8Array) {
		let buf = chunk;
		let base = this.bytes; // file offset of buf[0]
		if (this.carry.length) {
			const joined = new Uint8Array(this.carry.length + chunk.length);
			joined.set(this.carry);
			joined.set(chunk, this.carry.length);
			buf = joined;
			base = this.lineStart;
		}
		this.bytes += chunk.length;
		let start = 0;
		const len = buf.length;
		for (let i = 0; i < len; i++) {
			if (buf[i] === NL) {
				this.line(buf, start, i, base + start);
				start = i + 1;
			}
		}
		this.lineStart = base + start;
		this.carry = start < len ? buf.slice(start) : new Uint8Array(0);
	}

	/** Finishes (handles a last line without newline) and returns the toolpath. */
	finish(): Toolpath {
		if (this.carry.length) this.line(this.carry, 0, this.carry.length, this.lineStart);
		this.carry = new Uint8Array(0);
		const s = this.store;
		// Drop a trailing layer with no extrusion (end G-code: park, cool down).
		while (this.layers.length > 1 && this.layers[this.layers.length - 1] > this.lastExtrusionIdx) {
			this.layers.pop();
			this.layerZs.pop();
		}
		const layerStart = new Uint32Array(this.layers.length + 1);
		layerStart.set(this.layers);
		layerStart[this.layers.length] = s.n;
		const layerZ = new Float32Array(this.layerZs.map((z) => (Number.isFinite(z) ? z : 0)));
		const empty = !Number.isFinite(this.min[0]);
		return {
			positions: s.pos.slice(0, s.n * 3),
			kinds: s.kinds.slice(0, s.n),
			offsets: s.offs.slice(0, s.n),
			layerStart,
			layerZ,
			bounds: empty ? { min: [0, 0, 0], max: [0, 0, 0] } : { min: [...this.min], max: [...this.max] },
			stats: {
				bytes: this.bytes,
				lines: this.lines,
				moves: this.moves,
				points: s.n,
				layers: s.n ? this.layers.length : 0,
				minSegment: this.minSeg,
				kindsSeen: this.kindsSeen,
				layerComments: this.layerComments,
				typeComments: this.typeComments,
				filamentMm: Math.round(this.filament * 10) / 10,
				arcs: this.arcs
			}
		};
	}

	// --- lines --------------------------------------------------------------------------

	private line(b: Uint8Array, start: number, end: number, offset: number) {
		this.lines++;
		let i = start;
		while (i < end && (b[i] === SPACE || b[i] === TAB)) i++;
		if (end > i && b[end - 1] === CR) end--;
		if (i >= end) return;
		const c = b[i];
		if (c === SEMI) {
			this.comment(b, i + 1, end);
			return;
		}
		// Line numbers (N123 G1 …).
		if (c === 78 || c === 110) {
			i++;
			while (i < end && b[i] !== SPACE && b[i] !== TAB) i++;
			while (i < end && (b[i] === SPACE || b[i] === TAB)) i++;
			if (i >= end) return;
		}
		const letter = b[i] | 0x20; // lower case
		if (letter !== 103 /* g */ && letter !== 109 /* m */) return;
		// Command number.
		let j = i + 1;
		let num = 0;
		let digits = 0;
		while (j < end && b[j] >= 48 && b[j] <= 57) {
			num = num * 10 + (b[j] - 48);
			j++;
			digits++;
		}
		if (!digits) return;
		// G1.1 etc.: treat the base command only when there's no subcode.
		if (j < end && b[j] === 46) return;
		if (letter === 109) {
			if (num === 82) this.absE = true;
			else if (num === 83) this.absE = false;
			return;
		}
		switch (num) {
			case 0:
			case 1:
				this.words(b, j, end);
				this.move(offset);
				return;
			case 2:
			case 3:
				this.words(b, j, end);
				this.arc(num === 2, offset);
				return;
			case 90:
				this.absXYZ = true;
				// Marlin: G90 also sets E absolute unless M83 follows; most slicers send M82/M83 after anyway.
				return;
			case 91:
				this.absXYZ = false;
				return;
			case 92:
				this.words(b, j, end);
				if (!Number.isNaN(this.wX)) this.x = this.wX * this.scale;
				if (!Number.isNaN(this.wY)) this.y = this.wY * this.scale;
				if (!Number.isNaN(this.wZ)) this.z = this.wZ * this.scale;
				if (!Number.isNaN(this.wE)) this.e = this.wE * this.scale;
				return;
			case 20:
				this.scale = 25.4;
				return;
			case 21:
				this.scale = 1;
				return;
			case 28: {
				// Home: the named axes (or all) go to 0.
				this.words(b, j, end);
				const any = !Number.isNaN(this.wX) || !Number.isNaN(this.wY) || !Number.isNaN(this.wZ);
				if (!any || !Number.isNaN(this.wX)) this.x = 0;
				if (!any || !Number.isNaN(this.wY)) this.y = 0;
				if (!any || !Number.isNaN(this.wZ)) this.z = 0;
				return;
			}
		}
	}

	/** Reads X/Y/Z/E/F/I/J/R words (anything up to a comment). */
	private words(b: Uint8Array, i: number, end: number) {
		this.wX = this.wY = this.wZ = this.wE = this.wF = this.wI = this.wJ = this.wR = NaN;
		while (i < end) {
			const c = b[i];
			if (c === SEMI || c === PAREN) return;
			const l = c | 0x20;
			if (l < 97 || l > 122) {
				i++;
				continue;
			}
			// Parse a number after the letter.
			i++;
			let neg = false;
			if (b[i] === 45) {
				neg = true;
				i++;
			} else if (b[i] === 43) i++;
			let v = 0;
			let any = false;
			while (i < end && b[i] >= 48 && b[i] <= 57) {
				v = v * 10 + (b[i] - 48);
				i++;
				any = true;
			}
			if (b[i] === 46) {
				i++;
				let f = 0.1;
				while (i < end && b[i] >= 48 && b[i] <= 57) {
					v += (b[i] - 48) * f;
					f *= 0.1;
					i++;
					any = true;
				}
			}
			if (!any) continue;
			if (neg) v = -v;
			switch (l) {
				case 120: this.wX = v; break; // prettier-ignore
				case 121: this.wY = v; break; // prettier-ignore
				case 122: this.wZ = v; break; // prettier-ignore
				case 101: this.wE = v; break; // prettier-ignore
				case 102: this.wF = v; break; // prettier-ignore
				case 105: this.wI = v; break; // prettier-ignore
				case 106: this.wJ = v; break; // prettier-ignore
				case 114: this.wR = v; break; // prettier-ignore
			}
		}
	}

	private comment(b: Uint8Array, i: number, end: number) {
		while (i < end && (b[i] === SPACE || b[i] === TAB)) i++;
		const n = end - i;
		if (n < 4) return;
		const c0 = b[i] | 0x20;
		// LAYER_CHANGE, LAYER:n, LAYER n (not LAYER_COUNT, LAYER_HEIGHT…)
		if (c0 === 108 /* l */ && n >= 5 && (b[i + 1] | 0x20) === 97 && (b[i + 2] | 0x20) === 121 && (b[i + 3] | 0x20) === 101 && (b[i + 4] | 0x20) === 114) {
			const next = b[i + 5];
			if (n === 5 || next === 58 /* : */ || next === SPACE) {
				// Cura: ;LAYER:-1 etc. still a layer; ;LAYER_COUNT excluded by the check above.
				this.layerMark();
				return;
			}
			if (next === 95 /* _ */ && end - i >= 12 && ascii(b, i + 6, i + 12).toLowerCase() === 'change') {
				this.layerMark();
				return;
			}
			return;
		}
		// Bambu Studio: CHANGE_LAYER
		if (c0 === 99 /* c */ && n >= 12 && ascii(b, i, i + 12).toUpperCase() === 'CHANGE_LAYER') {
			this.layerMark();
			return;
		}
		// TYPE:… / FEATURE:…
		if (c0 === 116 /* t */ && n > 5 && (b[i + 4] === 58) && ascii(b, i, i + 4).toUpperCase() === 'TYPE') {
			this.setKind(ascii(b, i + 5, end));
			return;
		}
		if (c0 === 102 /* f */ && n > 8 && b[i + 7] === 58 && ascii(b, i, i + 7).toUpperCase() === 'FEATURE') {
			this.setKind(ascii(b, i + 8, end));
		}
	}

	private setKind(name: string) {
		this.typeComments = true;
		this.kind = featureKind(name);
	}

	private layerMark() {
		this.layerComments = true;
		this.pendingLayer = true;
	}

	// --- moves --------------------------------------------------------------------------

	private target(): [number, number, number, number] {
		const s = this.scale;
		const abs = this.absXYZ;
		const x = Number.isNaN(this.wX) ? this.x : abs ? this.wX * s : this.x + this.wX * s;
		const y = Number.isNaN(this.wY) ? this.y : abs ? this.wY * s : this.y + this.wY * s;
		const z = Number.isNaN(this.wZ) ? this.z : abs ? this.wZ * s : this.z + this.wZ * s;
		const e = Number.isNaN(this.wE) ? this.e : this.absE ? this.wE * s : this.e + this.wE * s;
		return [x, y, z, e];
	}

	private move(offset: number) {
		const [x, y, z, e] = this.target();
		const de = e - this.e;
		const moved = x !== this.x || y !== this.y || z !== this.z;
		this.e = e;
		if (!moved) return;
		const extruding = de > 1e-6 && (x !== this.x || y !== this.y);
		if (extruding) this.filament += de;
		this.x = x;
		this.y = y;
		this.z = z;
		this.moves++;
		this.point(x, y, z, extruding, offset);
	}

	private arc(cw: boolean, offset: number) {
		const [x, y, z, e] = this.target();
		const x0 = this.x;
		const y0 = this.y;
		const z0 = this.z;
		const e0 = this.e;
		let cx: number;
		let cy: number;
		if (!Number.isNaN(this.wI) || !Number.isNaN(this.wJ)) {
			cx = x0 + (Number.isNaN(this.wI) ? 0 : this.wI * this.scale);
			cy = y0 + (Number.isNaN(this.wJ) ? 0 : this.wJ * this.scale);
		} else if (!Number.isNaN(this.wR)) {
			// Centre from the radius (negative R: the long way round).
			const r = this.wR * this.scale;
			const dx = x - x0;
			const dy = y - y0;
			const d = Math.hypot(dx, dy);
			if (d === 0 || Math.abs(r) < d / 2) {
				this.move(offset);
				return;
			}
			const h = Math.sqrt(r * r - (d * d) / 4) * ((cw ? 1 : -1) * (r > 0 ? 1 : -1));
			cx = x0 + dx / 2 - (h * dy) / d;
			cy = y0 + dy / 2 + (h * dx) / d;
		} else {
			this.move(offset);
			return;
		}
		this.arcs++;
		const r = Math.hypot(x0 - cx, y0 - cy);
		const a0 = Math.atan2(y0 - cy, x0 - cx);
		let a1 = Math.atan2(y - cy, x - cx);
		let sweep = a1 - a0;
		if (cw) {
			if (sweep >= -1e-9) sweep -= 2 * Math.PI;
		} else if (sweep <= 1e-9) sweep += 2 * Math.PI;
		a1 = a0 + sweep;
		const steps = Math.max(1, Math.min(720, Math.ceil((Math.abs(sweep) * r) / this.arcChord)));
		const de = e - e0;
		const extruding = de > 1e-6;
		if (extruding) this.filament += de;
		for (let k = 1; k <= steps; k++) {
			const t = k / steps;
			const px = k === steps ? x : cx + r * Math.cos(a0 + sweep * t);
			const py = k === steps ? y : cy + r * Math.sin(a0 + sweep * t);
			const pz = z0 + (z - z0) * t;
			this.moves++;
			this.point(px, py, pz, extruding, offset);
		}
		this.x = x;
		this.y = y;
		this.z = z;
		this.e = e;
	}

	/** Appends (or merges) a point. */
	private point(x: number, y: number, z: number, extruding: boolean, offset: number): void {
		const s = this.store;
		const kind = extruding ? this.kind : TRAVEL;

		// Layers.
		if (extruding) {
			if (this.pendingLayer) {
				this.pendingLayer = false;
				this.newLayer(this.layerHasExtrusion ? this.lastExtrusionIdx + 1 : -1, z);
			} else if (!this.layerComments) {
				const lz = this.layerZs[this.layerZs.length - 1];
				if (this.layerHasExtrusion && Math.abs(z - lz) >= MIN_LAYER_STEP) this.newLayer(this.lastExtrusionIdx + 1, z);
			}
			if (!this.layerHasExtrusion) {
				this.layerHasExtrusion = true;
				this.layerZs[this.layerZs.length - 1] = z;
			}
		}

		const layerFirst = this.layers[this.layers.length - 1];
		const n = s.n;
		const prevKind = n ? s.kinds[n - 1] : -1;
		// Merge: consecutive travels collapse into one; short same-kind extrusions merge once decimating.
		if (this.soft && n - 1 >= layerFirst && prevKind === kind) {
			if (kind === TRAVEL) {
				this.write(n - 1, x, y, z, kind, offset);
				return;
			}
			if (this.minSeg > 0 && this.anchor >= 0) {
				const a = this.anchor * 3;
				const d = Math.hypot(x - s.pos[a], y - s.pos[a + 1], z - s.pos[a + 2]);
				if (d < this.minSeg) {
					this.write(n - 1, x, y, z, kind, offset);
					if (extruding) this.lastExtrusionIdx = n - 1;
					this.extend(x, y, z);
					return;
				}
			}
		}
		if (n >= s.cap) {
			if (n >= this.maxPoints) {
				this.decimate();
				// Still full (pathological input): drop the point rather than grow.
				if (s.n >= this.maxPoints) return;
				return this.point(x, y, z, extruding, offset);
			}
			s.grow(Math.min(this.maxPoints, n + 1));
		}
		this.write(n, x, y, z, kind, offset);
		s.n = n + 1;
		this.anchor = n - 1;
		this.soft = kind === TRAVEL || this.minSeg > 0;
		if (extruding) {
			this.lastExtrusionIdx = n;
			this.kindsSeen |= 1 << kind;
			this.extend(x, y, z);
		} else this.kindsSeen |= 1 << TRAVEL;
	}

	private write(i: number, x: number, y: number, z: number, kind: number, offset: number) {
		const s = this.store;
		s.pos[i * 3] = x;
		s.pos[i * 3 + 1] = y;
		s.pos[i * 3 + 2] = z;
		s.kinds[i] = kind;
		s.offs[i] = offset;
	}

	private extend(x: number, y: number, z: number) {
		if (x < this.min[0]) this.min[0] = x;
		if (y < this.min[1]) this.min[1] = y;
		if (z < this.min[2]) this.min[2] = z;
		if (x > this.max[0]) this.max[0] = x;
		if (y > this.max[1]) this.max[1] = y;
		if (z > this.max[2]) this.max[2] = z;
	}

	/** Starts a layer at point index `at` (-1: reuse the current, empty one). */
	private newLayer(at: number, z: number) {
		if (at < 0) {
			this.layerZs[this.layerZs.length - 1] = z;
			return;
		}
		const s = this.store;
		at = Math.min(at, s.n);
		const last = this.layers[this.layers.length - 1];
		if (at <= last) {
			this.layerZs[this.layerZs.length - 1] = z;
			return;
		}
		this.layers.push(at);
		this.layerZs.push(z);
		this.layerHasExtrusion = false;
		// No merging across a layer boundary.
		this.soft = false;
	}

	/**
	 * Over budget: doubles the minimum extrusion segment length and merges what's
	 * stored so far, until it's under 70% of the cap.
	 */
	private decimate() {
		const s = this.store;
		const target = Math.floor(this.maxPoints * 0.7);
		while (s.n > target) {
			this.minSeg = this.minSeg ? this.minSeg * 2 : 0.2;
			if (this.minSeg > 64) break;
			const pos = s.pos;
			const kinds = s.kinds;
			const offs = s.offs;
			const remap = this.layers.slice();
			let li = 0;
			let w = 0;
			let anchor = -1;
			let lastExtr = -1;
			for (let r = 0; r < s.n; r++) {
				while (li < this.layers.length && this.layers[li] === r) {
					remap[li] = w;
					li++;
					anchor = -1;
				}
				const k = kinds[r];
				const next = r + 1 < s.n ? kinds[r + 1] : -1;
				const boundary = li < this.layers.length && this.layers[li] === r + 1;
				let keep = true;
				if (k !== TRAVEL && anchor >= 0 && kinds[anchor] === k && next === k && !boundary) {
					const a = anchor * 3;
					const b = r * 3;
					keep = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]) >= this.minSeg;
				}
				if (!keep) continue;
				pos[w * 3] = pos[r * 3];
				pos[w * 3 + 1] = pos[r * 3 + 1];
				pos[w * 3 + 2] = pos[r * 3 + 2];
				kinds[w] = k;
				offs[w] = offs[r];
				if (k !== TRAVEL) lastExtr = w;
				anchor = w;
				w++;
			}
			for (; li < this.layers.length; li++) remap[li] = w;
			this.layers = remap;
			s.n = w;
			this.lastExtrusionIdx = lastExtr;
		}
		this.soft = false;
		this.anchor = s.n - 1;
	}
}

function ascii(b: Uint8Array, start: number, end: number): string {
	let s = '';
	for (let i = start; i < end && i - start < 64; i++) s += String.fromCharCode(b[i]);
	return s;
}

/** Parses a whole file held in memory (tests, small files). */
export function parseGcode(data: Uint8Array | string, opts?: ParserOptions & { chunk?: number }): Toolpath {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	const p = new GcodeParser(opts);
	const step = opts?.chunk ?? 1 << 20;
	for (let i = 0; i < bytes.length; i += step) p.push(bytes.subarray(i, i + step));
	return p.finish();
}

/** Last index i with `arr[i] <= v` (−1 when none). */
export function upperIndex(arr: ArrayLike<number>, v: number, lo = 0, hi = arr.length - 1): number {
	let ans = lo - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (arr[mid] <= v) {
			ans = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return ans;
}

/**
 * Where OctoPrint's file position is in the toolpath: the last point whose line has
 * been read (`offset < filepos`), and its layer. Null before the first move.
 */
export function locate(tp: Pick<Toolpath, 'offsets' | 'layerStart'>, filepos: number): { point: number; layer: number } | null {
	if (!tp.offsets.length) return null;
	// Offsets are non-decreasing; filepos counts bytes already read, so a line at
	// offset o has been sent once filepos > o.
	const point = upperIndex(tp.offsets, filepos - 1);
	if (point < 0) return null;
	const layers = tp.layerStart.length - 1;
	const layer = Math.max(0, Math.min(layers - 1, upperIndex(tp.layerStart, point, 0, layers - 1)));
	return { point, layer };
}

/** Whether the bytes look like a binary G-code file (Prusa .bgcode), which this parser can't read. */
export function isBinaryGcode(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x47 && head[1] === 0x43 && head[2] === 0x44 && head[3] === 0x45; // "GCDE"
}
