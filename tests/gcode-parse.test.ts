import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRUSION, FEATURES, GcodeParser, TRAVEL, featureKind, isBinaryGcode, locate, parseGcode } from '../src/lib/gcode/parse.ts';
// @ts-expect-error plain ESM script without types
import { sample } from '../scripts/gcode-samples.mjs';

const kind = (id: string) => FEATURES.findIndex((f) => f.id === id);
const pt = (tp: ReturnType<typeof parseGcode>, i: number) => Array.from(tp.positions.slice(i * 3, i * 3 + 3)).map((v) => Math.round(v * 1000) / 1000);

test('absolute moves, travels vs extrusions, byte offsets', () => {
	const src = 'G90\nM82\nG1 X10 Y0 F3000\nG1 X20 Y0 E1\nG1 X20 Y10 E2\n';
	const tp = parseGcode(src);
	assert.equal(tp.stats.points, 3);
	assert.deepEqual(pt(tp, 0), [10, 0, 0]);
	assert.deepEqual(pt(tp, 2), [20, 10, 0]);
	assert.deepEqual(Array.from(tp.kinds), [TRAVEL, EXTRUSION, EXTRUSION]);
	assert.equal(tp.offsets[1], src.indexOf('G1 X20 Y0'));
	assert.equal(tp.offsets[2], src.indexOf('G1 X20 Y10'));
	assert.equal(tp.stats.filamentMm, 2);
});

test('relative positioning (G91) and relative extrusion (M83), G92 resets', () => {
	const tp = parseGcode('G28\nG91\nM83\nG1 X5 Y5\nG1 X5 E0.5\nG1 X5 E-0.2\nG90\nG92 X0 Y0\nG1 X1 E0.1\n');
	assert.deepEqual(pt(tp, 0), [5, 5, 0]);
	assert.deepEqual(pt(tp, 1), [10, 5, 0]);
	assert.equal(tp.kinds[1], EXTRUSION);
	assert.equal(tp.kinds[2], TRAVEL, 'a move with a retraction is not an extrusion');
	// G92 X0 Y0 at (15,5): the next X1 is machine-coordinate 1 in the new frame.
	assert.deepEqual(pt(tp, 3), [1, 0, 0]);
	assert.equal(tp.kinds[3], EXTRUSION);
});

test('absolute E with G92 E0 resets (Cura style)', () => {
	const tp = parseGcode('M82\nG1 X1 Y0\nG1 X10 E1\nG92 E0\nG1 X20 E1\nG1 X30 E0.5\n');
	assert.deepEqual(Array.from(tp.kinds), [TRAVEL, EXTRUSION, EXTRUSION, TRAVEL]);
});

test('G20 inches, line numbers, comments after words, CRLF', () => {
	const tp = parseGcode('G20\r\nN10 G1 X1 Y1 ; to 25.4\r\nG21\r\nG1 X30 Y30 E1 ;TYPE:ignored inline\r\n');
	assert.deepEqual(pt(tp, 0), [25.4, 25.4, 0]);
	assert.deepEqual(pt(tp, 1), [30, 30, 0]);
});

test('G2/G3 arcs with I/J and R are interpolated', () => {
	// A counter-clockwise half circle of radius 10 from (10,0) to (-10,0) around the origin.
	const tp = parseGcode('G1 X10 Y0\nM83\nG3 X-10 Y0 I-10 J0 E1\n', { arcChord: 0.5 });
	const n = tp.stats.points;
	assert.ok(n > 60, `interpolated into many points (${n})`);
	for (let i = 1; i < n; i++) {
		const [x, y] = pt(tp, i);
		assert.ok(Math.abs(Math.hypot(x, y) - 10) < 0.01, 'on the circle');
		assert.ok(y >= -1e-6, 'CCW from +x to -x goes through +y');
	}
	assert.deepEqual(pt(tp, n - 1), [-10, 0, 0]);
	// Clockwise with R: from (0,0) to (10,0), radius 5 → centre (5,0), through +y.
	const cw = parseGcode('G1 X0 Y0\nM83\nG2 X10 Y0 R5 E1\n');
	const mid = pt(cw, Math.floor(cw.stats.points / 2));
	assert.ok(mid[1] > 4, `clockwise arc bulges to +y (${mid})`);
	assert.equal(cw.stats.arcs, 1);
});

test('layers from slicer comments; feature types from ;TYPE:', () => {
	const tp = parseGcode(sample('prusa', { layers: 7, segments: 24 }));
	assert.ok(tp.stats.layerComments && tp.stats.typeComments);
	// Purge line (z 0.3) + 7 layers.
	assert.equal(tp.stats.layers, 8);
	assert.deepEqual(Array.from(tp.layerZ).map((z) => Math.round(z * 100) / 100), [0.3, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4]);
	const seen = (id: string) => (tp.stats.kindsSeen & (1 << kind(id))) !== 0;
	for (const id of ['outer-wall', 'inner-wall', 'infill', 'solid-infill', 'top-bottom', 'skirt']) assert.ok(seen(id), id);
	assert.equal(tp.layerStart[tp.layerStart.length - 1], tp.stats.points);
	// Every point of layer k (after its leading travels) sits at layerZ[k].
	for (let l = 1; l < tp.stats.layers; l++) {
		for (let i = tp.layerStart[l]; i < tp.layerStart[l + 1]; i++) if (tp.kinds[i] !== TRAVEL) assert.ok(Math.abs(tp.positions[i * 3 + 2] - tp.layerZ[l]) < 1e-4);
	}
});

test('every slicer flavour yields the same layers and roughly the same filament', () => {
	const results = ['prusa', 'cura', 'orca', 'plain'].map((f) => [f, parseGcode(sample(f, { layers: 8 }))] as const);
	for (const [f, tp] of results) {
		assert.equal(tp.stats.layers, 9, `${f}: purge + 8 layers`);
		assert.ok(Math.abs(tp.stats.filamentMm - results[0][1].stats.filamentMm) / results[0][1].stats.filamentMm < 0.02, `${f} filament ${tp.stats.filamentMm}`);
	}
	const plain = results.find(([f]) => f === 'plain')![1];
	assert.equal(plain.stats.layerComments, false, 'plain: layers from Z');
	assert.equal(plain.stats.typeComments, false);
	assert.equal(plain.stats.kindsSeen, (1 << EXTRUSION) | (1 << TRAVEL));
	const orca = results.find(([f]) => f === 'orca')![1];
	assert.ok(orca.stats.arcs > 0);
});

test('z-hops and consecutive travels merge into one travel point', () => {
	const tp = parseGcode('M83\nG1 X0 Y0 Z0.2\nG1 X10 E1\nG1 Z0.6\nG0 X50 Y50\nG1 Z0.2\nG1 X60 E1\n');
	assert.deepEqual(Array.from(tp.kinds), [TRAVEL, EXTRUSION, TRAVEL, EXTRUSION]);
	assert.deepEqual(pt(tp, 2), [50, 50, 0.2]);
	assert.equal(tp.stats.layers, 1, 'z-hop travel does not start a layer');
});

test('Cura ;LAYER:n, Bambu CHANGE_LAYER and ;FEATURE: comments', () => {
	const cura = parseGcode(';LAYER_COUNT:2\n;LAYER:0\n;TYPE:WALL-OUTER\nM83\nG1 Z0.2\nG1 X10 E1\n;LAYER:1\n;TYPE:FILL\nG1 Z0.4\nG1 X0 E1\n');
	assert.equal(cura.stats.layers, 2);
	assert.equal(cura.kinds[cura.layerStart[1] + 1], kind('infill'));
	const bambu = parseGcode('; CHANGE_LAYER\n; FEATURE: Outer wall\nM83\nG1 Z0.2\nG1 X10 E1\n; CHANGE_LAYER\n; FEATURE: Support interface\nG1 Z0.4\nG1 X0 E1\n');
	assert.equal(bambu.stats.layers, 2);
	assert.equal(bambu.kinds[1], kind('outer-wall'));
	assert.equal(bambu.kinds[bambu.stats.points - 1], kind('support-interface'));
});

test('feature names from the major slicers', () => {
	const cases: [string, string][] = [
		['External perimeter', 'outer-wall'],
		['Perimeter', 'inner-wall'],
		['Overhang perimeter', 'overhang'],
		['Internal infill', 'infill'],
		['Solid infill', 'solid-infill'],
		['Top solid infill', 'top-bottom'],
		['Bridge infill', 'bridge'],
		['Gap fill', 'gap-fill'],
		['Skirt/Brim', 'skirt'],
		['Support material', 'support'],
		['Support material interface', 'support-interface'],
		['Wipe tower', 'tower'],
		['Outer wall', 'outer-wall'],
		['Inner wall', 'inner-wall'],
		['Sparse infill', 'infill'],
		['Internal solid infill', 'solid-infill'],
		['Top surface', 'top-bottom'],
		['Bottom surface', 'top-bottom'],
		['Prime tower', 'tower'],
		['Ironing', 'ironing'],
		['WALL-OUTER', 'outer-wall'],
		['WALL-INNER', 'inner-wall'],
		['SKIN', 'top-bottom'],
		['FILL', 'infill'],
		['SUPPORT', 'support'],
		['SUPPORT-INTERFACE', 'support-interface'],
		['SKIRT', 'skirt'],
		['PRIME-TOWER', 'tower'],
		['Custom', 'custom']
	];
	for (const [name, id] of cases) assert.equal(FEATURES[featureKind(name)].id, id, name);
});

test('chunk boundaries anywhere give identical results', () => {
	const src = sample('orca', { layers: 4 });
	const whole = parseGcode(src);
	for (const chunk of [1, 7, 64, 1000]) {
		const tp = parseGcode(src, { chunk });
		assert.equal(tp.stats.points, whole.stats.points, `chunk ${chunk}`);
		assert.deepEqual(tp.offsets, whole.offsets);
		assert.deepEqual(tp.layerStart, whole.layerStart);
	}
});

test('a point cap decimates short extrusion segments and keeps layers intact', () => {
	const src = sample('prusa', { layers: 30, segments: 720 });
	const full = parseGcode(src);
	const capped = parseGcode(src, { maxPoints: 20_000 });
	assert.ok(full.stats.points > 20_000);
	assert.ok(capped.stats.points <= 20_000, `${capped.stats.points}`);
	// A cap that isn't a multiple of the growth steps holds too.
	const odd = parseGcode(src, { maxPoints: 33_333 });
	assert.ok(odd.stats.points <= 33_333 && odd.stats.minSegment > 0, `${odd.stats.points}`);
	assert.ok(capped.stats.minSegment > 0);
	assert.equal(capped.stats.layers, full.stats.layers);
	assert.deepEqual(Array.from(capped.layerZ), Array.from(full.layerZ));
	// Offsets stay sorted (filepos lookup relies on it).
	for (let i = 1; i < capped.offsets.length; i++) assert.ok(capped.offsets[i] >= capped.offsets[i - 1]);
	// Layer starts point at points of the right height.
	for (let l = 1; l < capped.stats.layers; l++) {
		const i = capped.layerStart[l];
		const end = capped.layerStart[l + 1];
		let j = i;
		while (j < end && capped.kinds[j] === TRAVEL) j++;
		assert.ok(Math.abs(capped.positions[j * 3 + 2] - capped.layerZ[l]) < 1e-4, `layer ${l}`);
	}
});

test('locate maps OctoPrint file positions to points and layers', () => {
	const src = sample('prusa', { layers: 6, segments: 24 });
	const tp = parseGcode(src);
	assert.equal(locate(tp, 0), null, 'nothing read yet');
	// Just after the 4th layer's comment and its first extrusion line.
	const l3 = src.indexOf(';LAYER_CHANGE\n;Z:0.800');
	const firstExtr = src.indexOf('\nG1 X', src.indexOf(';TYPE:', l3)) + 1;
	const at = locate(tp, firstExtr + 5)!;
	assert.equal(Math.round(tp.layerZ[at.layer] * 100) / 100, 0.8);
	assert.equal(tp.offsets[at.point], firstExtr);
	// The end of the file: last point, last layer.
	const end = locate(tp, src.length)!;
	assert.equal(end.point, tp.stats.points - 1);
	assert.equal(end.layer, tp.stats.layers - 1);
});

test('binary G-code is recognised', () => {
	assert.ok(isBinaryGcode(new TextEncoder().encode('GCDE\x01\x00')));
	assert.ok(!isBinaryGcode(new TextEncoder().encode('G28\n')));
});

test('a streaming parser reports consumed bytes', () => {
	const p = new GcodeParser();
	p.push(new TextEncoder().encode('G1 X1'));
	assert.equal(p.consumed, 5);
	p.push(new TextEncoder().encode(' Y1\n'));
	const tp = p.finish();
	assert.deepEqual(pt(tp, 0), [1, 1, 0]);
});

test('framing ignores a purge line along the bed edge', async () => {
	const { partBounds } = await import('../src/lib/gcode/render.ts');
	const tp = parseGcode(sample('prusa', { layers: 6 }));
	assert.equal(tp.bounds.min[1], 5, 'the purge line is part of the raw bounds');
	const b = partBounds(tp);
	assert.ok(b.min[1] > 70 && b.max[1] <= 145.01, `framed y ${b.min[1]}–${b.max[1]}`);
	assert.ok(b.min[0] > 70, `framed x from ${b.min[0]}`);
});
