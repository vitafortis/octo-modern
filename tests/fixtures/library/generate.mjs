// Generates the slicer-style G-code fixtures in this folder: node tests/fixtures/library/generate.mjs tests/fixtures/library
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
const out = process.argv[2];

// --- tiny SDF renderer, so thumbnails look like slicer previews ------------------------
const v = { sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], len: (a) => Math.hypot(a[0], a[1], a[2]), norm: (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }, dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] };
const SHAPES = {
  // A rounded block with a hole through it (a bracket).
  bracket: (p) => { const q = [Math.abs(p[0]) - 0.9, Math.abs(p[1]) - 0.35, Math.abs(p[2]) - 0.6]; const box = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0) - 0.08; const hole = Math.hypot(p[0] - 0.35, p[2]) - 0.28; return Math.max(box, -hole); },
  // A torus lying flat (a cable clip ring).
  clip: (p) => Math.hypot(Math.hypot(p[0], p[2]) - 0.75, p[1]) - 0.28,
  // A spool hub: a short cylinder with a bore.
  spool: (p) => { const r = Math.hypot(p[0], p[2]); const d = [Math.abs(r - 0.62) - 0.38, Math.abs(p[1]) - 0.45]; return Math.min(Math.max(d[0], d[1]), 0) + Math.hypot(Math.max(d[0], 0), Math.max(d[1], 0)) - 0.04; },
  // A capsule (a knob).
  knob: (p) => { const y = Math.max(-0.4, Math.min(0.4, p[1])); return Math.hypot(p[0], p[1] - y, p[2]) - 0.6; }
};
function renderShape(w, h, shape, color) {
  const f = SHAPES[shape];
  const px = Buffer.alloc(w * h * 4);
  const eye = [2.6, 2.0, 2.6], target = [0, 0, 0], fwd = v.norm(v.sub(target, eye)), right = v.norm([fwd[2], 0, -fwd[0]]), up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  const light = v.norm([0.6, 1, 0.3]);
  const scale = 0.4 / Math.min(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = (x - w / 2) * scale * 2, sy = (y - h / 2) * scale * 2;
    const dir = v.norm([fwd[0] + right[0] * sx + up[0] * sy, fwd[1] + right[1] * sx + up[1] * sy, fwd[2] + right[2] * sx + up[2] * sy]);
    let t = 0, hit = false, p;
    for (let i = 0; i < 96 && t < 8; i++) { p = [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t]; const d = f(p); if (d < 0.001) { hit = true; break; } t += d; }
    const o = (y * w + x) * 4;
    if (!hit) continue; // transparent background
    const e = 0.002, n = v.norm([f([p[0] + e, p[1], p[2]]) - f([p[0] - e, p[1], p[2]]), f([p[0], p[1] + e, p[2]]) - f([p[0], p[1] - e, p[2]]), f([p[0], p[1], p[2] + e]) - f([p[0], p[1], p[2] - e])]);
    const diff = Math.max(0, v.dot(n, light)), rim = Math.pow(1 - Math.max(0, -v.dot(n, dir)), 3) * 0.25;
    const half = v.norm([light[0] - dir[0], light[1] - dir[1], light[2] - dir[2]]), spec = Math.pow(Math.max(0, v.dot(n, half)), 40) * 0.35;
    // Layer lines, like a sliced part.
    const layer = 0.93 + 0.07 * Math.cos(p[1] * 60);
    for (let c = 0; c < 3; c++) px[o + c] = Math.min(255, Math.round(color[c] * (0.32 + 0.68 * diff) * layer + 255 * (spec + rim)));
    px[o + 3] = 255;
  }
  return px;
}
function pngFrom(w, h, rgba) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (t, b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); const tb = Buffer.concat([Buffer.from(t), b]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(tb) >>> 0); return Buffer.concat([l, tb, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const png = (w, h, shape, color) => pngFrom(w, h, renderShape(w, h, shape, color));
/** QOI encoder (runs, index, RGBA): https://qoiformat.org */
function qoiFrom(w, h, rgba) {
  const head = Buffer.alloc(14); head.write('qoif'); head.writeUInt32BE(w, 4); head.writeUInt32BE(h, 8); head[12] = 4; head[13] = 0;
  const out = [head], index = new Array(64).fill(-1);
  let prev = 0x000000ff, run = 0; // r,g,b,a packed (a in low byte)
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    const px = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    if (px === prev) { run++; if (run === 62 || i === n - 1) { out.push(Buffer.from([0xc0 | (run - 1)])); run = 0; } continue; }
    if (run) { out.push(Buffer.from([0xc0 | (run - 1)])); run = 0; }
    const h6 = (r * 3 + g * 5 + b * 7 + a * 11) % 64;
    if (index[h6] === px) out.push(Buffer.from([h6]));
    else { index[h6] = px; out.push(Buffer.from([0xff, r, g, b, a])); }
    prev = px;
  }
  out.push(Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]));
  return Buffer.concat(out);
}
const qoi = (w, h, shape, color) => qoiFrom(w, h, renderShape(w, h, shape, color));
const jpg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const block = (tag, w, h, data) => {
  const b64 = data.toString('base64'); const lines = b64.match(/.{1,78}/g);
  return [``, `; ${tag} begin ${w}x${h} ${b64.length}`, ...lines.map((l) => `; ${l}`), `; ${tag} end`, `;`].join('\n');
};
const body = (n) => Array.from({ length: n }, (_, i) => `G1 X${(10 + (i % 90)).toFixed(3)} Y${(20 + (i % 70)).toFixed(3)} E${(i * 0.0123).toFixed(5)}`).join('\n');

// PrusaSlicer 2.7: PNG + QOI thumbnails up top, stats + config at the bottom.
writeFileSync(`${out}/prusaslicer.gcode`, [
  '; generated by PrusaSlicer 2.7.1+linux-x64-GTK3 on 2024-01-10 at 10:00:00 UTC', '', ';', '',
  block('thumbnail', 16, 16, png(16, 16, 'bracket', [250, 104, 0])), block('thumbnail_QOI', 313, 173, qoi(313, 173, 'bracket', [250, 104, 0])),
  '', '; external perimeters extrusion width = 0.45mm', '; perimeters extrusion width = 0.45mm', '',
  'M73 P0 R85', 'M201 X4000 Y4000 Z200 E2500', 'M862.3 P "MK4"', 'G28', body(400), 'M73 P100 R0',
  '; filament used [mm] = 1234.56', '; filament used [cm3] = 2.97', '; filament used [g] = 3.68', '; filament cost = 0.07',
  '; total filament used [g] = 3.68', '; total filament cost = 0.07', '; total filament used for wipe tower [g] = 0.00',
  '; estimated printing time (normal mode) = 1h 25m 3s', '; estimated first layer printing time (normal mode) = 1m 2s',
  '; estimated printing time (silent mode) = 1h 30m 0s', '', '; prusaslicer_config = begin', '; bed_temperature = 85',
  '; first_layer_bed_temperature = 85', '; first_layer_height = 0.2', '; first_layer_temperature = 240', '; filament_type = PETG',
  '; layer_height = 0.15', '; nozzle_diameter = 0.4', '; printer_model = MK4', '; temperature = 240', '; prusaslicer_config = end', ''
].join('\n'));

// SuperSlicer 2.5 (PrusaSlicer fork): JPG thumbnail, two extruders.
writeFileSync(`${out}/superslicer.gcode`, [
  '; generated by SuperSlicer 2.5.59.8 on 2024-03-02 at 18:21:07 UTC', '',
  block('thumbnail_JPG', 1, 1, jpg), block('thumbnail', 220, 220, png(220, 220, 'knob', [200, 200, 210])), '', 'G28', body(200),
  '; filament used [mm] = 1000.00, 250.50', '; filament used [cm3] = 2.41, 0.60', '; filament used [g] = 2.99, 0.75',
  '; total filament used [g] = 3.74', '; estimated printing time (normal mode) = 2d 3h 4m 5s', '',
  '; SuperSlicer_config = begin', '; bed_temperature = 60,60', '; filament_type = PLA;PETG', '; first_layer_height = 0.3',
  '; layer_height = 0.2', '; nozzle_diameter = 0.6,0.6', '; printer_model = ', '; temperature = 215,240', '; SuperSlicer_config = end', ''
].join('\n'));

// OrcaSlicer 2.1: HEADER_BLOCK with layer count, large thumbnail (runs past 64 KB), stats + CONFIG_BLOCK at the end.
const big = png(300, 300, 'clip', [40, 190, 90]);
const bigPad = Buffer.concat([big]); // deflate makes it small; pad with random-ish ancillary data to exceed 64 KB of base64
const tEXt = (() => { const data = Buffer.alloc(60000); for (let i = 0; i < data.length; i++) data[i] = 32 + ((i * 7919) % 90); const body = Buffer.concat([Buffer.from('Comment\0'), data]); const l = Buffer.alloc(4); l.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from('tEXt'), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(tb) >>> 0); return Buffer.concat([l, tb, c]); })();
const bigWithText = Buffer.concat([bigPad.subarray(0, 33), tEXt, bigPad.subarray(33)]);
writeFileSync(`${out}/orcaslicer.gcode`, [
  '; HEADER_BLOCK_START', '; generated by OrcaSlicer 2.1.1 on 2024-07-14 at 12:00:00', '; total layer number: 50',
  '; filament_density: 1.24', '; filament_diameter: 1.75', '; max_z_height: 10.00', '; HEADER_BLOCK_END', '',
  '; THUMBNAIL_BLOCK_START', block('thumbnail', 32, 32, png(32, 32, 'clip', [40, 190, 90])), block('thumbnail', 300, 300, bigWithText), '; THUMBNAIL_BLOCK_END', '',
  '; EXECUTABLE_BLOCK_START', 'M73 P0 R37', 'G28', body(20000), '; EXECUTABLE_BLOCK_END', '',
  '; filament used [mm] = 1302.86', '; filament used [cm3] = 3.13', '; filament used [g] = 3.89', '; filament cost = 0.08',
  '; total filament used [g] = 3.89', '; total filament cost = 0.08', '; total layers count = 50',
  '; estimated printing time (normal mode) = 37m 21s', '', '; CONFIG_BLOCK_START', '; curr_bed_type = Textured PEI Plate',
  '; filament_type = PLA', '; hot_plate_temp = 60', '; initial_layer_print_height = 0.2', '; layer_height = 0.2',
  '; nozzle_diameter = 0.4', '; nozzle_temperature = 220', '; printer_model = Voron 2.4 350', '; CONFIG_BLOCK_END', ''
].join('\n'));

// Cura 5 (Marlin flavour) with the "Create Thumbnail" post-processing script.
writeFileSync(`${out}/cura.gcode`, [
  ';FLAVOR:Marlin', ';TIME:5025', ';Filament used: 1.81262m', ';Layer height: 0.2', ';MINX:95.2', ';MINY:95.2', ';MINZ:0.2',
  ';MAXX:124.8', ';MAXY:124.8', ';MAXZ:12.2', ';TARGET_MACHINE.NAME:Creality Ender-3 Pro', ';Generated with Cura_SteamEngine 5.6.0',
  block('thumbnail', 200, 200, png(200, 200, 'spool', [40, 110, 240])), 'M140 S60', 'M105', 'M190 S60', 'M104 S200', 'M109 S200', ';LAYER_COUNT:61', ';LAYER:0',
  body(300), ';TIME_ELAPSED:5025.123', 'M140 S0', 'M107', 'M84', ';End of Gcode',
  ';SETTING_3 {"global_quality": "[general]\\\\nversion = 4\\\\nname = Standard Quality #2\\\\n"}', ''
].join('\n'));
console.log('ok');
