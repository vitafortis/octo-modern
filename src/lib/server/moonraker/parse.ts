/**
 * Turns Moonraker/Klipper data into octo·modern's shapes: printer objects
 * (print_stats, virtual_sdcard, extruder, heater_bed, …) into the live snapshot, file
 * listings and metadata into FileEntry trees, webcams into cameras, and the Control
 * tab's actions into G-code scripts. Pure (no I/O), so tests drive it directly.
 *
 * Heater keys follow OctoPrint's names so the rest of the app needn't care:
 * `extruder` → tool0, `extruder1` → tool1, `heater_bed` → bed, and a heater, fan or
 * sensor named like "chamber" → chamber.
 */
import { BadRequest } from '../http.ts';
import { fanCommand } from '#lib/control/jog.ts';
import { DEFAULT_PROFILE, type PrinterProfile } from '#lib/control/profile.ts';
import type { CustomControl } from '#lib/control/custom.ts';
import type { ControlAction } from '../control-actions.ts';
import type { Camera, StreamKind } from '../octoprint/webcam.ts';
import type { TempProfile } from '../octoprint/parse.ts';
import type { FileDetails } from '../backend/types.ts';
import type { JobInfo, LiveSnapshot, PrinterState, Progress, TempReading, TempSample } from '#lib/printer.ts';
import type { FileEntry, FileListing } from '#lib/types.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Printer objects by name, each a dict of fields (as `printer.objects.query/subscribe` return them). */
export type Status = Record<string, Obj>;

/** Klippy's state as Moonraker reports it (`server.info` klippy_state, `printer.info` state, `webhooks.state`). */
export interface Klippy {
	state: string;
	message: string | null;
}

/** Merges a `notify_status_update` diff into the full status (fields replace, objects merge). */
export function mergeStatus(into: Status, diff: unknown): Status {
	if (!isObj(diff)) return into;
	for (const [name, fields] of Object.entries(diff)) {
		if (!isObj(fields)) continue;
		into[name] = { ...(into[name] ?? {}), ...fields };
	}
	return into;
}

// --- heaters -------------------------------------------------------------------------

export interface HeaterRef {
	/** Klipper object, e.g. `extruder1`, `heater_bed`, `temperature_fan chamber`. */
	object: string;
	/** How a target is set: SET_HEATER_TEMPERATURE, SET_TEMPERATURE_FAN_TARGET, or not at all. */
	control: 'heater' | 'temperature_fan' | null;
}

/** Snapshot key → Klipper object, from `printer.objects.list`. */
export function heaterMap(objects: string[]): Record<string, HeaterRef> {
	const out: Record<string, HeaterRef> = {};
	for (const o of objects) {
		const ext = /^extruder(\d*)$/.exec(o);
		if (ext) out[`tool${ext[1] ? Number(ext[1]) : 0}`] = { object: o, control: 'heater' };
		else if (o === 'heater_bed') out.bed = { object: o, control: 'heater' };
	}
	const chamber =
		objects.find((o) => /^heater_generic\s+.*chamber/i.test(o)) ??
		objects.find((o) => /^temperature_fan\s+.*chamber/i.test(o)) ??
		objects.find((o) => /^temperature_sensor\s+.*chamber/i.test(o));
	if (chamber) out.chamber = { object: chamber, control: chamber.startsWith('heater_generic') ? 'heater' : chamber.startsWith('temperature_fan') ? 'temperature_fan' : null };
	return out;
}

/** What octo·modern subscribes to (null = every field of the object). */
export function subscription(objects: string[]): Record<string, string[] | null> {
	const has = (o: string) => objects.includes(o);
	const sub: Record<string, string[] | null> = {
		webhooks: ['state', 'state_message'],
		print_stats: ['state', 'filename', 'print_duration', 'total_duration', 'filament_used', 'message', 'info'],
		virtual_sdcard: ['progress', 'file_position', 'is_active', 'file_path'],
		display_status: ['progress', 'message'],
		toolhead: ['position', 'homed_axes', 'extruder'],
		gcode_move: ['gcode_position', 'speed_factor', 'extrude_factor']
	};
	if (has('fan')) sub.fan = ['speed'];
	if (has('pause_resume')) sub.pause_resume = ['is_paused'];
	for (const ref of Object.values(heaterMap(objects))) sub[ref.object] = ref.control ? ['temperature', 'target'] : ['temperature'];
	// Keep only what exists (and the always-present ones), so Klipper doesn't complain.
	return Object.fromEntries(Object.entries(sub).filter(([o]) => has(o) || o === 'webhooks' || o === 'print_stats' || o === 'virtual_sdcard' || o === 'toolhead' || o === 'gcode_move'));
}

export function tempsFromStatus(status: Status, map: Record<string, HeaterRef>): Record<string, TempReading> {
	const out: Record<string, TempReading> = {};
	for (const [key, ref] of Object.entries(map)) {
		const o = status[ref.object];
		if (!o) continue;
		const actual = num(o.temperature);
		const target = ref.control ? (num(o.target) ?? 0) : null;
		if (actual === null && target === null) continue;
		out[key] = { actual: actual === null ? null : Math.round(actual * 100) / 100, target };
	}
	return out;
}

export function sampleFrom(temps: Record<string, TempReading>, t: number): TempSample {
	const v: TempSample['v'] = {};
	for (const [k, r] of Object.entries(temps)) v[k] = [r.actual, r.target];
	return { t, v };
}

/**
 * Moonraker's temperature store (`server.temperature_store`: one reading per second per
 * object, newest last) as chart samples ending at `now`.
 */
export function samplesFromStore(store: unknown, map: Record<string, HeaterRef>, now: number, keepMs = 30 * 60_000): TempSample[] {
	if (!isObj(store)) return [];
	const series: { key: string; temps: unknown[]; targets: unknown[] }[] = [];
	for (const [key, ref] of Object.entries(map)) {
		const s = store[ref.object];
		if (!isObj(s) || !Array.isArray(s.temperatures)) continue;
		series.push({ key, temps: s.temperatures, targets: Array.isArray(s.targets) ? s.targets : [] });
	}
	const n = Math.max(0, ...series.map((s) => s.temps.length));
	const out: TempSample[] = [];
	for (let i = 0; i < n; i++) {
		const t = now - (n - 1 - i) * 1000;
		if (now - t > keepMs) continue;
		const v: TempSample['v'] = {};
		for (const s of series) {
			const j = i - (n - s.temps.length);
			if (j < 0) continue;
			const actual = num(s.temps[j]);
			const target = s.targets.length ? num(s.targets[s.targets.length - s.temps.length + j]) : null;
			v[s.key] = [actual, target];
		}
		if (Object.keys(v).length) out.push({ t, v });
	}
	return out;
}

// --- state, job, progress ------------------------------------------------------------

const KLIPPY_TEXT: Record<string, string> = { startup: 'Klipper starting', shutdown: 'Klipper shutdown', error: 'Klipper error', disconnected: 'Klipper not connected' };

/** Klippy's own state, preferring the live `webhooks` object over the last `printer.info`. */
export function klippyOf(status: Status, fallback: Klippy): Klippy {
	const w = status.webhooks;
	const state = str(w?.state) ?? fallback.state;
	return { state, message: str(w?.state_message) ?? (state === fallback.state ? fallback.message : null) };
}

export function stateFromStatus(status: Status, klippy: Klippy): { state: PrinterState; stateText: string; printerError: string | null } {
	if (klippy.state !== 'ready') {
		const msg = klippy.message?.trim() || null;
		if (klippy.state === 'startup') return { state: 'connecting', stateText: KLIPPY_TEXT.startup, printerError: null };
		if (klippy.state === 'shutdown' || klippy.state === 'error') return { state: 'error', stateText: KLIPPY_TEXT[klippy.state], printerError: msg };
		return { state: 'disconnected', stateText: KLIPPY_TEXT.disconnected, printerError: null };
	}
	const ps = str(status.print_stats?.state) ?? 'standby';
	switch (ps) {
		case 'printing':
			return { state: 'printing', stateText: 'Printing', printerError: null };
		case 'paused':
			return { state: 'paused', stateText: 'Paused', printerError: null };
		case 'error':
			// The print failed; Klipper itself is fine and ready for the next one.
			return { state: 'operational', stateText: 'Ready (last print failed)', printerError: null };
		default:
			return { state: 'operational', stateText: 'Ready', printerError: null };
	}
}

/** What octo·modern keeps of a file's metadata (`server.files.metadata`). */
export interface FileMeta {
	size: number | null;
	modified: number | null;
	estimatedTime: number | null;
	filamentMm: number | null;
	filamentG: number | null;
	gcodeStart: number | null;
	gcodeEnd: number | null;
	/** Largest thumbnail, relative to the gcodes root. */
	thumbnail: string | null;
}

/** The thumbnail with the most pixels, as a path relative to the gcodes root. */
export function pickThumbnail(thumbs: unknown, dir: string): string | null {
	if (!Array.isArray(thumbs)) return null;
	const best = thumbs
		.filter(isObj)
		.filter((t) => typeof t.relative_path === 'string')
		.sort((a, b) => (num(b.width) ?? 0) * (num(b.height) ?? 0) - (num(a.width) ?? 0) * (num(a.height) ?? 0))[0];
	if (!best) return null;
	return safeThumbnailPath(joinRel(dir, best.relative_path as string));
}

export function parseMeta(raw: unknown, path = ''): FileMeta {
	const m = isObj(raw) ? raw : {};
	const dir = dirOf(path);
	return {
		size: num(m.size),
		modified: num(m.modified),
		estimatedTime: num(m.estimated_time),
		filamentMm: num(m.filament_total),
		filamentG: num(m.filament_weight_total),
		gcodeStart: num(m.gcode_start_byte),
		gcodeEnd: num(m.gcode_end_byte),
		thumbnail: pickThumbnail(m.thumbnails, dir)
	};
}

export function fileDetailsFromMeta(meta: FileMeta): FileDetails {
	return {
		size: meta.size,
		filamentMm: meta.filamentMm,
		perTool: meta.filamentMm && meta.filamentMm > 0 ? { 0: meta.filamentMm } : {},
		estimatedS: meta.estimatedTime,
		thumbnail: meta.thumbnail,
		last: null
	};
}

const baseOf = (p: string) => p.split('/').pop() ?? p;
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name.replace(/^\/+/, '')}` : name.replace(/^\/+/, ''));

export function jobFromStatus(status: Status, meta: FileMeta | null): JobInfo | null {
	const path = str(status.print_stats?.filename);
	if (!path) return null;
	const name = baseOf(path);
	return {
		file: { name, path, display: name, origin: 'local', size: meta?.size ?? null, date: meta?.modified ?? null },
		estimatedPrintTime: meta?.estimatedTime ?? null,
		filament: meta?.filamentMm != null ? { tool0: { length: meta.filamentMm, volume: null } } : null,
		user: null
	};
}

export function progressFromStatus(status: Status, meta: FileMeta | null): Progress | null {
	const ps = status.print_stats ?? {};
	const vs = status.virtual_sdcard ?? {};
	if (!str(ps.filename)) return null;
	const state = str(ps.state);
	const pos = num(vs.file_position);
	let fraction = num(vs.progress);
	// Like Mainsail: progress through the G-code itself, without the slicer's header and thumbnails.
	if (meta?.gcodeStart != null && meta.gcodeEnd != null && meta.gcodeEnd > meta.gcodeStart && pos != null && pos > 0) {
		fraction = Math.max(0, Math.min(1, (pos - meta.gcodeStart) / (meta.gcodeEnd - meta.gcodeStart)));
	}
	if (state === 'complete') fraction = 1;
	const printDuration = num(ps.print_duration);
	const total = num(ps.total_duration);
	let left: number | null = null;
	let origin: string | null = null;
	if (state === 'complete') {
		left = 0;
	} else if (meta?.estimatedTime && printDuration != null) {
		left = Math.max(0, meta.estimatedTime - printDuration);
		origin = 'estimate';
	} else if (fraction && fraction > 0.01 && printDuration) {
		left = Math.max(0, printDuration / fraction - printDuration);
		origin = 'linear';
	}
	return {
		completion: fraction == null ? null : Math.round(fraction * 10000) / 100,
		printTime: total ?? printDuration,
		printTimeLeft: left == null ? null : Math.round(left),
		printTimeLeftOrigin: origin,
		filepos: pos
	};
}

/** The snapshot fields that come from Klipper's status. */
export function snapshotFromStatus(status: Status, klippy: Klippy, map: Record<string, HeaterRef>, meta: FileMeta | null): Partial<LiveSnapshot> {
	const ready = klippy.state === 'ready';
	const pos = status.gcode_move?.gcode_position ?? status.toolhead?.position;
	return {
		...stateFromStatus(status, klippy),
		job: ready ? jobFromStatus(status, meta) : null,
		progress: ready ? progressFromStatus(status, meta) : null,
		temps: ready ? tempsFromStatus(status, map) : {},
		currentZ: ready && Array.isArray(pos) && num(pos[2]) != null ? Math.round((pos[2] as number) * 100) / 100 : null
	};
}

/** The version line: `Klipper v0.12.0 · Moonraker v0.9.3`. */
export function versionText(klipper: unknown, moonraker: unknown): string | null {
	const k = str(klipper)?.replace(/-.*$/, '');
	const m = str(moonraker)?.replace(/-.*$/, '');
	return [k && `Klipper ${k}`, m && `Moonraker ${m}`].filter(Boolean).join(' · ') || null;
}

// --- events ----------------------------------------------------------------------------

export interface PrintEvent {
	name: string;
	payload: unknown;
}

/**
 * Turns print_stats state changes into OctoPrint-style events (PrintStarted, PrintPaused,
 * PrintResumed, PrintDone, PrintCancelled, PrintFailed), so the history, notifications
 * and queue work the same for Klipper. The first observation only sets the baseline.
 */
export class PrintTransitions {
	private prev: string | null = null;
	private file: string | null = null;

	reset() {
		this.prev = null;
		this.file = null;
	}

	next(status: Status, klippy: Klippy): PrintEvent[] {
		const ps = status.print_stats ?? {};
		const filename = str(ps.filename) ?? this.file;
		const state = klippy.state === 'ready' ? (str(ps.state) ?? 'standby') : this.prev === 'printing' || this.prev === 'paused' ? 'shutdown' : this.prev;
		const prev = this.prev;
		this.prev = state;
		if (filename) this.file = filename;
		if (prev === null || state === prev || !state) return [];
		const file = filename ? { name: baseOf(filename), path: filename, origin: 'local' } : {};
		const time = num(ps.print_duration);
		const active = (s: string | null) => s === 'printing' || s === 'paused';
		const out: PrintEvent[] = [];
		if (state === 'printing' && prev === 'paused') out.push({ name: 'PrintResumed', payload: file });
		else if (state === 'printing') out.push({ name: 'PrintStarted', payload: file });
		else if (state === 'paused' && prev === 'printing') out.push({ name: 'PrintPaused', payload: file });
		else if (active(prev)) {
			if (state === 'complete') out.push({ name: 'PrintDone', payload: { ...file, time } });
			else if (state === 'cancelled' || state === 'standby') out.push({ name: 'PrintCancelled', payload: { ...file, time } });
			else out.push({ name: 'PrintFailed', payload: { ...file, time, reason: state === 'shutdown' ? 'shutdown' : 'error' } });
		}
		return out;
	}
}

// --- files ------------------------------------------------------------------------------

/** Thumbnails live under the gcodes root, usually in `.thumbs` folders; nothing else is proxied. */
export function safeThumbnailPath(src: unknown): string | null {
	if (typeof src !== 'string') return null;
	const s = src.replace(/^\/+/, '');
	if (!s || s.length > 1024 || s.includes('\\') || s.split('/').some((p) => p === '..' || p === '.') || !/\.(png|jpe?g|webp)$/i.test(s)) return null;
	return s;
}

const GCODE = /\.(gcode|gco|g|gc|bgcode|ufp)$/i;

/** One file of `server.files.get_directory` (with `extended`, metadata fields are merged in). */
export function fileEntry(raw: unknown, dir: string): FileEntry | null {
	if (!isObj(raw)) return null;
	const name = str(raw.filename);
	if (!name) return null;
	const path = joinRel(dir, name);
	return {
		origin: 'local',
		path,
		name,
		display: name,
		type: GCODE.test(name) ? 'machinecode' : 'other',
		size: num(raw.size),
		date: num(raw.modified) != null ? Math.round(num(raw.modified)!) : null,
		estimatedPrintTime: num(raw.estimated_time),
		filamentMm: num(raw.filament_total),
		thumbnail: pickThumbnail(raw.thumbnails, dir),
		prints: null
	};
}

/** A folder's listing; `children` of sub-folders are filled by the caller (one request per folder). */
export function directoryEntries(raw: unknown, dir: string): { files: FileEntry[]; dirs: FileEntry[]; free: number | null; total: number | null } {
	const r = isObj(raw) ? raw : {};
	const files = (Array.isArray(r.files) ? r.files : []).map((f) => fileEntry(f, dir)).filter((e): e is FileEntry => !!e && !e.name.startsWith('.'));
	const dirs: FileEntry[] = (Array.isArray(r.dirs) ? r.dirs : [])
		.filter(isObj)
		.map((d) => str(d.dirname))
		.filter((n): n is string => !!n && !n.startsWith('.'))
		.map((n) => ({ origin: 'local', path: joinRel(dir, n), name: n, display: n, type: 'folder', size: null, date: null, estimatedPrintTime: null, filamentMm: null, thumbnail: null, prints: null, children: [] }));
	const du = isObj(r.disk_usage) ? r.disk_usage : {};
	return { files, dirs, free: num(du.free), total: num(du.total) };
}

export function listing(entries: FileEntry[], free: number | null, total: number | null): FileListing {
	return { files: entries, free, total };
}

// --- webcams ------------------------------------------------------------------------------

function webcamKind(service: string | null, stream: string | null): StreamKind | null {
	if (!stream) return null;
	const s = (service ?? '').toLowerCase();
	if (s.startsWith('webrtc')) return 'webrtc';
	if (s === 'hlsstream' || /\.m3u8(\?|$)/i.test(stream)) return 'hls';
	if (s === 'iframe' || s === 'ipstream') return 'webrtc';
	return 'mjpeg';
}

/**
 * Where relative webcam URLs point. Mainsail/Fluidd resolve them against their own page,
 * so with Moonraker's own port (7125) in the base URL they belong to the same host on
 * the web server's default port.
 */
export function webcamBase(baseUrl: string): string {
	try {
		const u = new URL(baseUrl);
		if (u.port === '7125') return `${u.protocol}//${u.hostname}`;
		return `${u.protocol}//${u.host}`;
	} catch {
		return baseUrl;
	}
}

function resolve(raw: unknown, base: string): string | null {
	const s = str(raw)?.trim();
	if (!s) return null;
	try {
		const u = new URL(s, `${base}/`);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
	} catch {
		return null;
	}
}

/** Cameras from `server.webcams.list`. */
export function camerasFromWebcams(raw: unknown, baseUrl: string): Camera[] {
	const list = isObj(raw) && Array.isArray(raw.webcams) ? raw.webcams : Array.isArray(raw) ? raw : [];
	const base = webcamBase(baseUrl);
	const out: Camera[] = [];
	for (const w of list.filter(isObj)) {
		if (w.enabled === false) continue;
		const stream = resolve(w.stream_url, base);
		const kind = webcamKind(str(w.service), stream);
		const snapshot = resolve(w.snapshot_url, base);
		if (!stream && !snapshot) continue;
		const id = str(w.name) ?? `cam${out.length + 1}`;
		if (out.some((c) => c.id === id)) continue;
		const rot = num(w.rotation) ?? 0;
		out.push({
			id,
			label: id,
			streamUrl: stream,
			snapshotUrl: snapshot,
			kind,
			flipH: w.flip_horizontal === true,
			flipV: w.flip_vertical === true,
			rotate90: rot === 90 || rot === 270,
			source: 'octoprint'
		});
	}
	return out;
}

// --- control ------------------------------------------------------------------------------

/** Klipper's name for a tool's extruder: tool0 → extruder, tool1 → extruder1. */
export function extruderName(tool: string): string {
	const n = Number(/^tool(\d+)$/.exec(tool)?.[1] ?? 0);
	return n ? `extruder${n}` : 'extruder';
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** The Control tab's actions as Klipper G-code (one script, newline-separated). */
export function controlScript(a: ControlAction): string {
	switch (a.action) {
		case 'jog': {
			const axes = (['x', 'y', 'z'] as const).filter((ax) => a[ax]);
			const speed = axes.every((ax) => ax === 'z') ? 600 : 6000;
			return ['G91', `G1 ${axes.map((ax) => `${ax.toUpperCase()}${fmt(a[ax]!)}`).join(' ')} F${speed}`, 'G90'].join('\n');
		}
		case 'home':
			return a.axes.length === 3 ? 'G28' : `G28 ${a.axes.map((x) => x.toUpperCase()).join(' ')}`;
		case 'feedrate':
			return `M220 S${a.factor}`;
		case 'flowrate':
			return `M221 S${a.factor}`;
		case 'fan':
			return fanCommand(a.speed);
		case 'motors_off':
			return 'M84';
		case 'tool':
			return `ACTIVATE_EXTRUDER EXTRUDER=${extruderName(a.tool)}`;
		case 'extrude':
			return [...(a.tool ? [`ACTIVATE_EXTRUDER EXTRUDER=${extruderName(a.tool)}`] : []), 'M83', `G1 E${fmt(a.amount)} F300`].join('\n');
		case 'custom':
			if (a.script) throw new BadRequest('OctoPrint GCODE scripts don’t exist on Klipper; use a macro');
			return (a.commands ?? []).join('\n');
	}
}

/** G-code that sets one heater's target. */
export function targetScript(key: string, value: number, map: Record<string, HeaterRef>): string {
	const ref = map[key] ?? (key.startsWith('tool') ? { object: extruderName(key), control: 'heater' as const } : key === 'bed' ? { object: 'heater_bed', control: 'heater' as const } : null);
	if (!ref || !ref.control) throw new BadRequest(key === 'chamber' ? 'This printer has no chamber heater in its Klipper config' : `Unknown heater "${key}"`);
	const name = ref.object.includes(' ') ? ref.object.slice(ref.object.indexOf(' ') + 1) : ref.object;
	return ref.control === 'temperature_fan' ? `SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=${name} TARGET=${value}` : `SET_HEATER_TEMPERATURE HEATER=${name} TARGET=${value}`;
}

/** Klipper's macros (`gcode_macro NAME`) as one-button custom controls; `_HIDDEN` ones are left out. */
export function macroControls(objects: string[]): CustomControl[] {
	const names = objects
		.filter((o) => o.startsWith('gcode_macro '))
		.map((o) => o.slice('gcode_macro '.length).trim())
		.filter((n) => n && !n.startsWith('_'))
		.sort((a, b) => a.localeCompare(b))
		.slice(0, 80);
	if (!names.length) return [];
	return [{ kind: 'section', name: 'Macros', layout: 'horizontal_grid', collapsed: false, children: names.map((n) => ({ kind: 'command', name: n, commands: [n], confirm: null, inputs: [] })) }];
}

/** A printer profile (build volume, extruders, bed) from Klipper's `configfile.settings`. */
export function profileFromConfig(settings: unknown, objects: string[]): PrinterProfile {
	const s = isObj(settings) ? settings : {};
	const sec = (n: string) => (isObj(s[n]) ? (s[n] as Obj) : {});
	const printer = sec('printer');
	const kin = str(printer.kinematics) ?? 'cartesian';
	const range = (axis: string) => {
		const st = sec(`stepper_${axis}`);
		const min = num(st.position_min) ?? 0;
		const max = num(st.position_max);
		return max == null ? null : { min, max };
	};
	const x = range('x');
	const y = range('y');
	const z = range('z');
	const extruders = objects.filter((o) => /^extruder\d*$/.test(o)).length || 1;
	const delta = kin === 'delta';
	const radius = num(sec('printer').print_radius) ?? num(sec('printer').delta_radius);
	const width = delta && radius ? radius * 2 : x ? x.max - x.min : DEFAULT_PROFILE.volume.width;
	const depth = delta && radius ? radius * 2 : y ? y.max - y.min : DEFAULT_PROFILE.volume.depth;
	const centered = delta || (!!x && x.min < 0 && Math.abs(x.min) > x.max * 0.4);
	const maxZv = num(printer.max_z_velocity);
	return {
		...DEFAULT_PROFILE,
		id: 'klipper',
		name: 'Klipper config',
		model: kin,
		volume: { width, depth, height: z ? z.max : num(printer.minimum_z_position) ?? DEFAULT_PROFILE.volume.height, formFactor: delta ? 'circular' : 'rectangular', origin: centered ? 'center' : 'lowerleft' },
		heatedBed: objects.includes('heater_bed'),
		heatedChamber: !!heaterMap(objects).chamber?.control,
		extruders,
		nozzleDiameter: num(sec('extruder').nozzle_diameter) ?? DEFAULT_PROFILE.nozzleDiameter,
		axes: { ...DEFAULT_PROFILE.axes, z: { speed: maxZv ? Math.min(600, maxZv * 60) : 600, inverted: false } }
	};
}

/**
 * Temperature presets Mainsail keeps in Moonraker's database (`mainsail` → `presets`):
 * `{ presets: { <id>: { name, values: { extruder: { bool, value }, heater_bed: … } } } }`.
 */
export function presetsFromMainsail(raw: unknown, map: Record<string, HeaterRef>): TempProfile[] {
	const root = isObj(raw) && isObj(raw.value) ? raw.value : raw;
	const presets = isObj(root) && isObj(root.presets) ? root.presets : isObj(root) ? root : {};
	const byObject = Object.fromEntries(Object.entries(map).map(([k, r]) => [r.object, k]));
	const out: TempProfile[] = [];
	for (const p of Object.values(presets)) {
		if (!isObj(p) || !str(p.name) || !isObj(p.values)) continue;
		const prof: TempProfile = { name: str(p.name)!, extruder: null, bed: null, chamber: null };
		for (const [object, v] of Object.entries(p.values)) {
			if (!isObj(v) || v.bool === false) continue;
			const val = num(v.value);
			const key = byObject[object] ?? (object === 'extruder' ? 'tool0' : object === 'heater_bed' ? 'bed' : null);
			if (val == null || !key) continue;
			if (key === 'tool0') prof.extruder = val;
			else if (key === 'bed') prof.bed = val;
			else if (key === 'chamber') prof.chamber = val;
		}
		if (prof.extruder != null || prof.bed != null || prof.chamber != null) out.push(prof);
	}
	return out.slice(0, 20);
}

/** Terminal lines from Moonraker's G-code store (`Send:` for commands, `Recv:` for responses, like OctoPrint's log). */
export function logLines(store: unknown): string[] {
	const list = isObj(store) && Array.isArray(store.gcode_store) ? store.gcode_store : Array.isArray(store) ? store : [];
	return list.filter(isObj).flatMap((e) => {
		const msg = str(e.message);
		if (!msg) return [];
		return msg.split('\n').map((l) => (e.type === 'command' ? `Send: ${l}` : `Recv: ${l}`));
	});
}
