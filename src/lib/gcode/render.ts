/**
 * WebGL2 toolpath renderer. Every segment is one instance of a 4-vertex strip, expanded
 * to a screen-space ribbon in the vertex shader (WebGL line width is stuck at 1 px on
 * most platforms): wide enough to read on a phone, and as wide as the real extrusion
 * once zoomed in. The point arrays are uploaded once; layer ranges, travel moves,
 * hidden features and the live print position are all uniforms and draw ranges.
 *
 * Views: an orbiting 3D camera (perspective) and a 2D top-down layer view
 * (orthographic) that shows the selected layer over a faint copy of the one below.
 */
import { KIND_COUNT, TRAVEL, type Toolpath } from './parse.ts';

export type ViewMode = '3d' | '2d';

export interface DrawState {
	mode: ViewMode;
	/** Highest layer shown. */
	layer: number;
	/** Lowest layer shown (3D). */
	minLayer: number;
	showTravel: boolean;
	/** Bit mask of hidden kinds (1 << kind). */
	hidden: number;
	/** Live print position: the last point printed (-1: no live job). */
	current: number;
	/** Live: show what's still to print as a ghost. */
	ghost: boolean;
}

type Mat4 = Float32Array;

// --- small matrix helpers (column-major) --------------------------------------------------

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
	const f = 1 / Math.tan(fovy / 2);
	const m = new Float32Array(16);
	m[0] = f / aspect;
	m[5] = f;
	m[10] = (far + near) / (near - far);
	m[11] = -1;
	m[14] = (2 * far * near) / (near - far);
	return m;
}

function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
	const m = new Float32Array(16);
	m[0] = 2 / (r - l);
	m[5] = 2 / (t - b);
	m[10] = -2 / (f - n);
	m[12] = -(r + l) / (r - l);
	m[13] = -(t + b) / (t - b);
	m[14] = -(f + n) / (f - n);
	m[15] = 1;
	return m;
}

function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
	let zx = eye[0] - target[0],
		zy = eye[1] - target[1],
		zz = eye[2] - target[2];
	let l = Math.hypot(zx, zy, zz) || 1;
	zx /= l;
	zy /= l;
	zz /= l;
	let xx = up[1] * zz - up[2] * zy,
		xy = up[2] * zx - up[0] * zz,
		xz = up[0] * zy - up[1] * zx;
	l = Math.hypot(xx, xy, xz) || 1;
	xx /= l;
	xy /= l;
	xz /= l;
	const yx = zy * xz - zz * xy,
		yy = zz * xx - zx * xz,
		yz = zx * xy - zy * xx;
	const m = new Float32Array(16);
	m[0] = xx;
	m[1] = yx;
	m[2] = zx;
	m[4] = xy;
	m[5] = yy;
	m[6] = zy;
	m[8] = xz;
	m[9] = yz;
	m[10] = zz;
	m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
	m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
	m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
	m[15] = 1;
	return m;
}

function mul(a: Mat4, b: Mat4): Mat4 {
	const o = new Float32Array(16);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
	return o;
}

// --- shaders ----------------------------------------------------------------------------

const SEG_VS = `#version 300 es
precision highp float;
precision highp int;
in vec3 aA;
in vec3 aB;
in uint aKind;
uniform mat4 uMVP;
uniform vec2 uViewport;
uniform float uProjScale;   // pixels per world unit at w = 1
uniform float uMinWidth;    // px
uniform float uLineWidth;   // mm (extrusion width)
uniform vec3 uPalette[${KIND_COUNT}];
uniform uint uHidden;
uniform bool uShowTravel;
uniform int uBase;
uniform int uStride;
uniform int uCurrent;
uniform int uGhostFrom;     // points at or after this are ghosts (alpha)
uniform float uAlpha;
uniform vec2 uZRange;
uniform bool uShade;
out vec4 vColor;
void main() {
	int idx = uBase + gl_InstanceID * uStride;
	bool travel = aKind == ${TRAVEL}u;
	if ((uHidden & (1u << aKind)) != 0u || (travel && !uShowTravel)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
	vec4 a = uMVP * vec4(aA, 1.0);
	vec4 b = uMVP * vec4(aB, 1.0);
	if (a.w <= 0.0 || b.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
	vec2 half_ = uViewport * 0.5;
	vec2 sa = a.xy / a.w * half_;
	vec2 sb = b.xy / b.w * half_;
	vec2 d = sb - sa;
	float len = length(d);
	vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
	vec2 nrm = vec2(-dir.y, dir.x);
	int c = gl_VertexID;
	bool atB = c >= 2;
	float side = (c == 1 || c == 3) ? 1.0 : -1.0;
	vec4 p = atB ? b : a;
	float w = travel ? 1.0 : max(uMinWidth, uLineWidth * uProjScale / p.w);
	w = min(w, 48.0);
	vec2 off = nrm * side * w * 0.5;
	if (!travel) off += dir * (atB ? 1.0 : -1.0) * w * 0.35;
	p.xy += off / half_ * p.w;
	gl_Position = p;
	vec3 col = uPalette[aKind];
	if (uShade && !travel) {
		float h = clamp((aB.z - uZRange.x) / max(uZRange.y - uZRange.x, 1e-3), 0.0, 1.0);
		col *= mix(0.62, 1.0, h);
		// Alternate segments a touch, so walls read as layers.
		col *= ((idx & 1) == 0) ? 1.0 : 0.96;
	}
	float alpha = uAlpha;
	if (uCurrent >= 0 && idx > uCurrent && idx >= uGhostFrom) alpha *= 0.14;
	if (travel) alpha *= 0.75;
	vColor = vec4(col * alpha, alpha);
}`;

const SEG_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

const GRID_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;

const GRID_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
	const prog = gl.createProgram()!;
	for (const [type, src] of [
		[gl.VERTEX_SHADER, vs],
		[gl.FRAGMENT_SHADER, fs]
	] as const) {
		const sh = gl.createShader(type)!;
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(sh)}`);
		gl.attachShader(prog, sh);
	}
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(prog)}`);
	return prog;
}

/** Converts any CSS colour (oklch, hex…) to linear-ish RGB 0–1 via a 1×1 canvas. */
export function cssColor(value: string): [number, number, number] {
	const c = document.createElement('canvas');
	c.width = c.height = 1;
	const g = c.getContext('2d', { willReadFrequently: true })!;
	g.fillStyle = '#000';
	g.fillStyle = value || '#888';
	g.fillRect(0, 0, 1, 1);
	const d = g.getImageData(0, 0, 1, 1).data;
	return [d[0] / 255, d[1] / 255, d[2] / 255];
}

/**
 * What to frame: the extrusions without outliers (a purge line along the bed's edge would
 * otherwise shrink the part to a corner). 1st–99th percentile in X and Y of a sample of
 * extrusion points, widened back to the real extents when they're close.
 */
export function partBounds(tp: Pick<Toolpath, 'positions' | 'kinds' | 'bounds'>): Toolpath['bounds'] {
	const n = tp.kinds.length;
	const step = Math.max(1, Math.floor(n / 50_000));
	const xs: number[] = [];
	const ys: number[] = [];
	for (let i = 0; i < n; i += step) {
		if (tp.kinds[i] === TRAVEL) continue;
		xs.push(tp.positions[i * 3]);
		ys.push(tp.positions[i * 3 + 1]);
	}
	if (xs.length < 20) return tp.bounds;
	xs.sort((a, b) => a - b);
	ys.sort((a, b) => a - b);
	const q = (a: number[], f: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))];
	const pick = (lo: number, hi: number, full: number, side: 'min' | 'max') => {
		const v = side === 'min' ? lo : hi;
		// Keep the true extent unless it's far beyond the percentile (an outlier).
		const span = Math.max(1, hi - lo);
		return Math.abs(full - v) < span * 0.1 ? full : v;
	};
	const [x0, x1, y0, y1] = [q(xs, 0.01), q(xs, 0.99), q(ys, 0.01), q(ys, 0.99)];
	const { min, max } = tp.bounds;
	return {
		min: [pick(x0, x1, min[0], 'min'), pick(y0, y1, min[1], 'min'), min[2]],
		max: [pick(x0, x1, max[0], 'max'), pick(y0, y1, max[1], 'max'), max[2]]
	};
}

export interface Camera3D {
	target: [number, number, number];
	distance: number;
	/** Radians around Z. */
	yaw: number;
	/** Radians above the bed. */
	pitch: number;
}

export interface Camera2D {
	center: [number, number];
	/** World units (mm) per CSS pixel. */
	scale: number;
}

export class ToolpathRenderer {
	readonly canvas: HTMLCanvasElement;
	private gl: WebGL2RenderingContext;
	private seg!: WebGLProgram;
	private grid!: WebGLProgram;
	private segVao!: WebGLVertexArrayObject;
	private gridVao!: WebGLVertexArrayObject;
	private posBuf!: WebGLBuffer;
	private kindBuf!: WebGLBuffer;
	private gridBuf!: WebGLBuffer;
	private gridCount = 0;
	private loc: Record<string, WebGLUniformLocation | null> = {};
	private attrA = 0;
	private attrB = 0;
	private attrKind = 0;
	private tp: Toolpath | null = null;
	private frameBounds: Toolpath['bounds'] | null = null;
	private palette = new Float32Array(KIND_COUNT * 3);
	private gridColor: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
	private frame = 0;
	private dpr = 1;
	cam3: Camera3D = { target: [0, 0, 0], distance: 200, yaw: -Math.PI / 3, pitch: Math.PI / 5 };
	cam2: Camera2D = { center: [0, 0], scale: 0.5 };
	state: DrawState = { mode: '3d', layer: 0, minLayer: 0, showTravel: false, hidden: 0, current: -1, ghost: true };
	/** Segments per frame at rest (a quarter of it while the view moves). */
	budget: number;
	private moving = 0;
	private settle: ReturnType<typeof setTimeout> | undefined;
	/** Segments drawn in the last frame, and the coarsest stride used. */
	drawn = 0;
	stride = 1;
	/** Called after each frame (e.g. to place HTML overlays). */
	onframe?: () => void;
	lost = false;

	constructor(canvas: HTMLCanvasElement, opts: { budget?: number } = {}) {
		this.canvas = canvas;
		this.budget = opts.budget ?? 2_000_000;
		const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: false });
		if (!gl) throw new Error('This browser has no WebGL2');
		this.gl = gl;
		this.init();
		canvas.addEventListener('webglcontextlost', (e) => {
			e.preventDefault();
			this.lost = true;
		});
		canvas.addEventListener('webglcontextrestored', () => {
			this.lost = false;
			this.init();
			if (this.tp) this.upload(this.tp, false);
			this.redraw();
		});
	}

	private init() {
		const gl = this.gl;
		this.seg = compile(gl, SEG_VS, SEG_FS);
		this.grid = compile(gl, GRID_VS, GRID_FS);
		for (const n of ['uMVP', 'uViewport', 'uProjScale', 'uMinWidth', 'uLineWidth', 'uPalette', 'uHidden', 'uShowTravel', 'uBase', 'uStride', 'uCurrent', 'uGhostFrom', 'uAlpha', 'uZRange', 'uShade'])
			this.loc[n] = gl.getUniformLocation(this.seg, n);
		this.loc.gMVP = gl.getUniformLocation(this.grid, 'uMVP');
		this.loc.gColor = gl.getUniformLocation(this.grid, 'uColor');
		this.attrA = gl.getAttribLocation(this.seg, 'aA');
		this.attrB = gl.getAttribLocation(this.seg, 'aB');
		this.attrKind = gl.getAttribLocation(this.seg, 'aKind');
		this.posBuf = gl.createBuffer()!;
		this.kindBuf = gl.createBuffer()!;
		this.gridBuf = gl.createBuffer()!;
		this.segVao = gl.createVertexArray()!;
		this.gridVao = gl.createVertexArray()!;
		gl.bindVertexArray(this.segVao);
		gl.enableVertexAttribArray(this.attrA);
		gl.enableVertexAttribArray(this.attrB);
		gl.enableVertexAttribArray(this.attrKind);
		gl.vertexAttribDivisor(this.attrA, 1);
		gl.vertexAttribDivisor(this.attrB, 1);
		gl.vertexAttribDivisor(this.attrKind, 1);
		gl.bindVertexArray(this.gridVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
		const gp = gl.getAttribLocation(this.grid, 'aPos');
		gl.enableVertexAttribArray(gp);
		gl.vertexAttribPointer(gp, 3, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);
	}

	/** Reads the palette (CSS tokens) again, e.g. after a theme change. */
	setColors(kinds: [number, number, number][], grid: [number, number, number]) {
		kinds.forEach((c, i) => this.palette.set(c, i * 3));
		this.gridColor = [...grid, 1];
		this.redraw();
	}

	/** Uploads a toolpath and frames it. */
	upload(tp: Toolpath, frame = true) {
		const gl = this.gl;
		this.tp = tp;
		this.frameBounds = null;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
		gl.bufferData(gl.ARRAY_BUFFER, tp.positions, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.kindBuf);
		gl.bufferData(gl.ARRAY_BUFFER, tp.kinds, gl.STATIC_DRAW);
		this.buildGrid(tp);
		if (frame) this.resetView();
		this.redraw();
	}

	/** A 10 mm grid under the part (plus a margin), as a stand-in for the bed. */
	private buildGrid(tp: Toolpath) {
		const { min, max } = tp.bounds;
		const step = 10;
		const x0 = Math.floor((min[0] - 10) / step) * step;
		const x1 = Math.ceil((max[0] + 10) / step) * step;
		const y0 = Math.floor((min[1] - 10) / step) * step;
		const y1 = Math.ceil((max[1] + 10) / step) * step;
		const v: number[] = [];
		const z = Math.min(0, min[2]) - 0.01;
		for (let x = x0; x <= x1; x += step) v.push(x, y0, z, x, y1, z);
		for (let y = y0; y <= y1; y += step) v.push(x0, y, z, x1, y, z);
		this.gridCount = v.length / 3;
		const gl = this.gl;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
	}

	resetView() {
		const tp = this.tp;
		if (!tp) return;
		const { min, max } = this.frameBounds ?? (this.frameBounds = partBounds(tp));
		const cx = (min[0] + max[0]) / 2;
		const cy = (min[1] + max[1]) / 2;
		const cz = (min[2] + max[2]) / 2;
		const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 10);
		this.cam3 = { target: [cx, cy, cz * 0.5], distance: size * 1.45, yaw: -Math.PI / 3, pitch: Math.PI / 5 };
		const w = this.canvas.clientWidth || 1;
		const h = this.canvas.clientHeight || 1;
		const span = Math.max(max[0] - min[0], max[1] - min[1], 10) * 1.15;
		this.cam2 = { center: [cx, cy], scale: span / Math.min(w, h) };
		this.redraw();
	}

	/** Matrix for the current view, and the projection scale (px per unit at w = 1). */
	private matrices(): { mvp: Mat4; projScale: number } {
		const w = this.canvas.width;
		const h = this.canvas.height;
		if (this.state.mode === '2d') {
			const c = this.cam2;
			const hw = (this.canvas.clientWidth * c.scale) / 2;
			const hh = (this.canvas.clientHeight * c.scale) / 2;
			const p = ortho(c.center[0] - hw, c.center[0] + hw, c.center[1] - hh, c.center[1] + hh, -1000, 1000);
			return { mvp: p, projScale: this.dpr / c.scale };
		}
		const c = this.cam3;
		const eye = [
			c.target[0] + c.distance * Math.cos(c.pitch) * Math.cos(c.yaw),
			c.target[1] + c.distance * Math.cos(c.pitch) * Math.sin(c.yaw),
			c.target[2] + c.distance * Math.sin(c.pitch)
		];
		const fov = Math.PI / 4;
		const p = perspective(fov, w / Math.max(1, h), Math.max(0.1, c.distance / 500), c.distance * 20 + 1000);
		const v = lookAt(eye, c.target, [0, 0, 1]);
		return { mvp: mul(p, v), projScale: (h / 2) * p[5] };
	}

	/** Projects a world point to CSS pixels in the canvas (null when behind the camera). */
	project(x: number, y: number, z: number): [number, number] | null {
		const { mvp } = this.matrices();
		const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
		const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
		const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
		if (cw <= 0) return null;
		return [((cx / cw + 1) / 2) * this.canvas.clientWidth, ((1 - cy / cw) / 2) * this.canvas.clientHeight];
	}

	redraw() {
		if (this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.draw();
		});
	}

	private resize() {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.dpr = dpr;
		const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
		const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}
	}

	/**
	 * Draws points [first, last) (segment i joins point i-1 to point i). With `stride` k > 1,
	 * only every k-th point is used: a coarser polyline for big files and while moving.
	 */
	private segments(first: number, last: number, uniforms: { alpha: number; ghostFrom: number }, stride = 1) {
		const gl = this.gl;
		first = Math.max(1, first);
		if (last - first <= 0) return;
		const k = Math.max(1, Math.floor(stride));
		const count = Math.floor((last - first) / k);
		if (count > 0) {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
			gl.vertexAttribPointer(this.attrA, 3, gl.FLOAT, false, 12 * k, (first - 1) * 12);
			gl.vertexAttribPointer(this.attrB, 3, gl.FLOAT, false, 12 * k, (first - 1 + k) * 12);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.kindBuf);
			gl.vertexAttribIPointer(this.attrKind, 1, gl.UNSIGNED_BYTE, k, first - 1 + k);
			gl.uniform1i(this.loc.uBase, first - 1 + k);
			gl.uniform1i(this.loc.uStride, k);
			gl.uniform1f(this.loc.uAlpha, uniforms.alpha);
			gl.uniform1i(this.loc.uGhostFrom, uniforms.ghostFrom);
			gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
			this.drawn += count;
		}
		// The remainder at full detail, so the strided polyline ends where the range does.
		if (k > 1 && first + count * k < last) this.segments(first + count * k, last, uniforms, 1);
	}

	/** [lo, hi) within the frame budget: the top layers at full detail, the rest coarser if need be. */
	private budgeted(tp: Toolpath, lo: number, hi: number, top: number, uniforms: { alpha: number; ghostFrom: number }) {
		const budget = performance.now() - this.moving < 200 ? this.budget / 4 : this.budget;
		if (budget < this.budget) {
			clearTimeout(this.settle);
			this.settle = setTimeout(() => this.redraw(), 220);
		}
		const full = Math.max(lo, Math.min(hi, tp.layerStart[Math.max(0, top - 1)]));
		const rest = full - lo;
		const k = rest > budget ? Math.ceil(rest / Math.max(1, budget - (hi - full))) : 1;
		this.stride = Math.max(this.stride, k);
		this.segments(lo, full, uniforms, k);
		this.segments(full, hi, uniforms, 1);
	}

	private draw() {
		if (this.lost) return;
		this.resize();
		const gl = this.gl;
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		const tp = this.tp;
		if (!tp || !tp.stats.points) return;
		this.drawn = 0;
		this.stride = 1;
		const { mvp, projScale } = this.matrices();
		const s = this.state;
		const layers = tp.layerStart.length - 1;
		const L = Math.max(0, Math.min(layers - 1, s.layer));
		const two = s.mode === '2d';

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

		// Grid.
		gl.disable(gl.DEPTH_TEST);
		gl.useProgram(this.grid);
		gl.uniformMatrix4fv(this.loc.gMVP, false, mvp);
		gl.uniform4fv(this.loc.gColor, this.gridColor);
		gl.bindVertexArray(this.gridVao);
		gl.drawArrays(gl.LINES, 0, this.gridCount);

		gl.useProgram(this.seg);
		gl.bindVertexArray(this.segVao);
		gl.uniformMatrix4fv(this.loc.uMVP, false, mvp);
		gl.uniform2f(this.loc.uViewport, this.canvas.width, this.canvas.height);
		gl.uniform1f(this.loc.uProjScale, projScale);
		gl.uniform1f(this.loc.uMinWidth, (two ? 1.6 : 1.4) * this.dpr);
		gl.uniform1f(this.loc.uLineWidth, 0.42);
		gl.uniform3fv(this.loc.uPalette, this.palette);
		gl.uniform1ui(this.loc.uHidden, s.hidden >>> 0);
		gl.uniform1i(this.loc.uShowTravel, s.showTravel ? 1 : 0);
		gl.uniform1i(this.loc.uCurrent, s.current);
		gl.uniform2f(this.loc.uZRange, tp.bounds.min[2], tp.layerZ[L] ?? tp.bounds.max[2]);
		gl.uniform1i(this.loc.uShade, two ? 0 : 1);

		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		const noGhost = 0x7fffffff;
		if (two) {
			// Layer below, faint; then the layer.
			gl.disable(gl.DEPTH_TEST);
			if (L > 0) this.segments(tp.layerStart[L - 1], tp.layerStart[L], { alpha: 0.18, ghostFrom: noGhost });
			this.segments(tp.layerStart[L], tp.layerStart[L + 1], { alpha: 1, ghostFrom: s.current >= 0 ? 0 : noGhost });
		} else {
			const lo = tp.layerStart[Math.max(0, Math.min(L, s.minLayer))];
			const hi = tp.layerStart[L + 1];
			if (s.current >= 0 && s.current + 1 < hi) {
				// Printed part solid, the rest of the shown layers as a ghost.
				gl.depthMask(true);
				this.budgeted(tp, lo, s.current + 1, L, { alpha: 1, ghostFrom: noGhost });
				if (s.ghost) {
					gl.depthMask(false);
					this.budgeted(tp, Math.max(lo, s.current + 1), hi, L + 1, { alpha: 1, ghostFrom: 0 });
					gl.depthMask(true);
				}
			} else this.budgeted(tp, lo, hi, L, { alpha: 1, ghostFrom: noGhost });
		}
		gl.bindVertexArray(null);
		this.canvas.dataset.drawn = String(this.drawn);
		this.canvas.dataset.stride = String(this.stride);
		this.onframe?.();
	}

	// --- interaction --------------------------------------------------------------------

	orbit(dx: number, dy: number) {
		this.moving = performance.now();
		const c = this.cam3;
		c.yaw -= dx * 0.008;
		c.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, c.pitch + dy * 0.008));
		this.redraw();
	}

	/** Pans by a CSS-pixel delta. */
	pan(dx: number, dy: number) {
		this.moving = performance.now();
		if (this.state.mode === '2d') {
			this.cam2.center[0] -= dx * this.cam2.scale;
			this.cam2.center[1] += dy * this.cam2.scale;
		} else {
			const c = this.cam3;
			const k = (c.distance * Math.tan(Math.PI / 8) * 2) / Math.max(1, this.canvas.clientHeight);
			// Camera right and up vectors.
			const rx = -Math.sin(c.yaw);
			const ry = Math.cos(c.yaw);
			const ux = -Math.sin(c.pitch) * Math.cos(c.yaw);
			const uy = -Math.sin(c.pitch) * Math.sin(c.yaw);
			const uz = Math.cos(c.pitch);
			c.target[0] += (-dx * rx + dy * ux) * k;
			c.target[1] += (-dx * ry + dy * uy) * k;
			c.target[2] += dy * uz * k;
		}
		this.redraw();
	}

	/** Zooms by a factor (>1 zooms in), around a CSS-pixel point in 2D. */
	zoom(factor: number, at?: [number, number]) {
		this.moving = performance.now();
		if (this.state.mode === '2d') {
			const c = this.cam2;
			const next = Math.max(0.005, Math.min(5, c.scale / factor));
			if (at) {
				const wx = c.center[0] + (at[0] - this.canvas.clientWidth / 2) * c.scale;
				const wy = c.center[1] - (at[1] - this.canvas.clientHeight / 2) * c.scale;
				c.center[0] = wx - (at[0] - this.canvas.clientWidth / 2) * next;
				c.center[1] = wy + (at[1] - this.canvas.clientHeight / 2) * next;
			}
			c.scale = next;
		} else this.cam3.distance = Math.max(2, Math.min(5000, this.cam3.distance / factor));
		this.redraw();
	}

	/** Frees the GPU buffers. */
	dispose() {
		cancelAnimationFrame(this.frame);
		clearTimeout(this.settle);
		const gl = this.gl;
		gl.deleteBuffer(this.posBuf);
		gl.deleteBuffer(this.kindBuf);
		gl.deleteBuffer(this.gridBuf);
		gl.deleteVertexArray(this.segVao);
		gl.deleteVertexArray(this.gridVao);
		gl.deleteProgram(this.seg);
		gl.deleteProgram(this.grid);
		this.tp = null;
		gl.getExtension('WEBGL_lose_context')?.loseContext();
	}
}
