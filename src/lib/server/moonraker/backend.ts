/**
 * The Moonraker (Klipper) backend: jobs, files, controls and webcams over Moonraker's
 * HTTP API. Live state comes from ./live.ts.
 *
 * Differences from OctoPrint, handled here so callers needn't care:
 * - Klipper has no "selected file": printing a file starts it; "start"/"restart"
 *   reprint the last file (print_stats.filename).
 * - Controls are G-code scripts (jog, home, extrude, fan, temperatures).
 * - M112 goes to `printer.emergency_stop`, which acts even when the G-code queue is busy.
 * - Uploads carry Moonraker's form fields (`root`, `path`, `print`) in the multipart body.
 */
import { OctoPrintError, toOctoPrintError } from '../octoprint/errors.ts';
import { streamRequest } from '../octoprint/transport.ts';
import { BadRequest } from '../http.ts';
import type { ControlAction } from '../control-actions.ts';
import type { ControlInfo, FileDetails, JobCommand, Origin, PrinterBackend, UploadOptions, UploadResult } from '../backend/types.ts';
import { encodeSegments, moonrakerError, type MoonrakerClient } from './client.ts';
import {
	camerasFromWebcams,
	controlScript,
	directoryEntries,
	fileDetailsFromMeta,
	heaterMap,
	klippyOf,
	macroControls,
	parseMeta,
	presetsFromMainsail,
	profileFromConfig,
	safeThumbnailPath,
	stateFromStatus,
	targetScript,
	type Status
} from './parse.ts';
import type { FileEntry, FileListing } from '#lib/types.ts';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isEmergencyStop = (line: string) => /^\s*M112\b/i.test(line);

const MAX_DIRS = 80;
const MAX_DEPTH = 6;
const OBJECTS_TTL_MS = 60_000;
const objectCache = new Map<string, { at: number; objects: string[] }>();

/**
 * Prepends form fields to a multipart body (Moonraker reads `root`, `path` and `print`
 * from the form). Returns the new body and its length.
 */
export function withFormFields(body: ReadableStream<Uint8Array>, contentType: string, length: number, fields: Record<string, string>): { body: ReadableStream<Uint8Array>; length: number } {
	const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
	const b = boundary?.[1] ?? boundary?.[2]?.trim();
	if (!b) throw new BadRequest('The upload has no multipart boundary');
	const head = Buffer.from(
		Object.entries(fields)
			.map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
			.join(''),
		'utf8'
	);
	const reader = body.getReader();
	let sentHead = false;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!sentHead) {
				sentHead = true;
				controller.enqueue(head);
				return;
			}
			const { value, done } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
	return { body: stream, length: length + head.length };
}

export class MoonrakerBackend implements PrinterBackend {
	readonly kind = 'moonraker' as const;
	readonly client: MoonrakerClient;
	/** Tells the live feed what octo·modern sent, for the terminal (Moonraker doesn't echo it). */
	private onSent: (script: string) => void;

	constructor(client: MoonrakerClient, opts: { onSent?: (script: string) => void } = {}) {
		this.client = client;
		this.onSent = opts.onSent ?? (() => {});
	}

	get host() {
		return this.client.host;
	}

	/** `printer.objects.list`, cached for a minute. */
	async objects(fresh = false): Promise<string[]> {
		const key = this.client.target.baseUrl;
		const hit = objectCache.get(key);
		if (!fresh && hit && Date.now() - hit.at < OBJECTS_TTL_MS) return hit.objects;
		const objects = ((await this.client.objectList())?.objects ?? []).filter((o): o is string => typeof o === 'string');
		objectCache.set(key, { at: Date.now(), objects });
		return objects;
	}

	async status() {
		const info = await this.client.serverInfo();
		const state = str(info?.klippy_state) ?? 'ready';
		if (state !== 'ready') {
			const p = await this.client.printerInfo().catch(() => ({}) as Record<string, unknown>);
			return { state: stateFromStatus({}, { state: str(p.state) ?? state, message: str(p.state_message) }).state, job: null };
		}
		const q = await this.client.query({ print_stats: ['state', 'filename'], webhooks: ['state', 'state_message'] });
		const status = (q?.status ?? {}) as Status;
		const filename = str(status.print_stats?.filename);
		const name = filename?.split('/').pop() ?? null;
		return {
			state: stateFromStatus(status, klippyOf(status, { state: 'ready', message: null })).state,
			job: filename && name ? { file: { name, path: filename, display: name, origin: 'local', size: null, date: null }, estimatedPrintTime: null, filament: null, user: null } : null
		};
	}

	async jobCommand(command: JobCommand) {
		if (command === 'pause') return void (await this.client.post('/printer/print/pause'));
		if (command === 'resume') return void (await this.client.post('/printer/print/resume'));
		if (command === 'cancel') return void (await this.client.post('/printer/print/cancel'));
		// start / restart: Klipper has no selected file; print the last one again.
		const q = await this.client.query({ print_stats: ['filename', 'state'] });
		const filename = str(q?.status?.print_stats?.filename);
		if (!filename) throw new OctoPrintError('No file to print', { status: 409, code: 'NO_FILE', hint: 'Klipper has no selected file: start a print from the Files tab.' });
		await this.client.post('/printer/print/start', { filename });
	}

	async selectFile(_origin: Origin, path: string, print: boolean) {
		if (!print) throw new BadRequest('Klipper can’t load a file without printing it');
		await this.client.post('/printer/print/start', { filename: path });
	}

	/** Walks the gcodes root (one request per folder, extended so metadata comes along). */
	async files(): Promise<FileListing> {
		let free: number | null = null;
		let total: number | null = null;
		let budget = MAX_DIRS;
		const walk = async (dir: string, depth: number): Promise<FileEntry[]> => {
			budget--;
			const raw = await this.client.get<unknown>(`/server/files/directory?path=${encodeURIComponent(dir ? `gcodes/${dir}` : 'gcodes')}&extended=true`);
			const d = directoryEntries(raw, dir);
			if (!dir) ((free = d.free), (total = d.total));
			for (const f of d.dirs) {
				if (depth < MAX_DEPTH && budget > 0) f.children = await walk(f.path, depth + 1).catch(() => []);
			}
			return [...d.dirs, ...d.files];
		};
		const files = await walk('', 0);
		return { files, free, total };
	}

	async deleteFile(_origin: Origin, path: string) {
		const res = await this.client.request('DELETE', `/server/files/gcodes/${encodeSegments(path)}`, { allow: [404] });
		if (res.status !== 404) return void (await res.body?.cancel().catch(() => {}));
		await res.body?.cancel().catch(() => {});
		// Not a file: a folder (with its contents, as OctoPrint does).
		await this.client.call('DELETE', `/server/files/directory?path=${encodeURIComponent(`gcodes/${path}`)}&force=true`);
	}

	async createFolder(name: string, parent: string) {
		await this.client.post('/server/files/directory', { path: ['gcodes', parent, name].filter(Boolean).join('/') });
	}

	async metadata(path: string): Promise<Record<string, unknown> | null> {
		const res = await this.client.request('GET', `/server/files/metadata?filename=${encodeURIComponent(path)}`, { allow: [400, 404], timeoutMs: 6_000 });
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			return null;
		}
		const j = (await res.json().catch(() => null)) as { result?: Record<string, unknown> } | null;
		return j?.result ?? null;
	}

	async fileDetails(_origin: Origin, path: string): Promise<FileDetails | null> {
		try {
			const raw = await this.metadata(path);
			return raw ? fileDetailsFromMeta(parseMeta(raw, path)) : null;
		} catch {
			return null;
		}
	}

	async fileSize(path: string): Promise<number | null> {
		const res = await this.client.request('HEAD', `/server/files/gcodes/${encodeSegments(path)}`, { allow: [404, 405], timeoutMs: 6_000 });
		await res.body?.cancel().catch(() => {});
		if (res.status === 404) return null;
		const n = Number(res.headers.get('content-length'));
		if (res.ok && Number.isFinite(n)) return n;
		const meta = await this.metadata(path).catch(() => null);
		return meta ? (typeof meta.size === 'number' ? meta.size : -1) : null;
	}

	async upload(o: UploadOptions): Promise<UploadResult> {
		if (o.origin === 'sdcard') throw new BadRequest('Klipper printers have no SD card upload');
		const fields: Record<string, string> = { root: 'gcodes' };
		if (o.folder) fields.path = o.folder;
		if (o.print) fields.print = 'true';
		const { body, length } = withFormFields(o.body, o.contentType, o.length, fields);
		let res: { status: number; text: string };
		try {
			res = await streamRequest(this.client.url('/server/files/upload'), {
				method: 'POST',
				headers: { ...this.client.headers(), 'content-type': o.contentType, 'content-length': String(length) },
				body,
				verifyTls: this.client.target.verifyTls,
				signal: o.signal,
				timeoutMs: o.timeoutMs ?? 5 * 60_000
			});
		} catch (err) {
			throw toOctoPrintError(err, this.client.host);
		}
		if (res.status < 200 || res.status >= 300) throw moonrakerError(res.status, res.text);
		let r: { item?: { path?: string }; print_started?: boolean; result?: { item?: { path?: string }; print_started?: boolean } } = {};
		try {
			r = JSON.parse(res.text || '{}') ?? {};
		} catch {}
		const out = r.result ?? r;
		const started = !!out.print_started;
		return { path: out.item?.path ?? null, selected: started, printing: started };
	}

	download(path: string, opts: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }) {
		return this.client.request('GET', `/server/files/gcodes/${encodeSegments(path)}`, {
			headers: { accept: '*/*', ...opts.headers },
			allow: [206, 404, 416],
			timeoutMs: opts.timeoutMs ?? 60 * 60_000,
			signal: opts.signal
		});
	}

	thumbnailSource(src: unknown) {
		return safeThumbnailPath(src);
	}

	thumbnail(src: string, opts: { timeoutMs?: number } = {}) {
		return this.client.request('GET', `/server/files/gcodes/${encodeSegments(src)}`, { headers: { accept: 'image/*' }, timeoutMs: opts.timeoutMs });
	}

	private async run(script: string) {
		this.onSent(script);
		await this.client.gcode(script);
	}

	async setTargets(targets: Record<string, number>) {
		const map = heaterMap(await this.objects());
		await this.run(Object.entries(targets).map(([k, v]) => targetScript(k, v, map)).join('\n'));
	}

	async sendCommands(commands: string[]) {
		if (commands.some(isEmergencyStop)) return this.emergencyStop();
		await this.run(commands.join('\n'));
	}

	async emergencyStop() {
		this.onSent('M112');
		await this.client.post('/printer/emergency_stop');
	}

	control(action: ControlAction) {
		return this.run(controlScript(action));
	}

	async controlInfo(): Promise<ControlInfo> {
		const objects = await this.objects(true);
		let settings: unknown = null;
		let controlsError: string | null = null;
		try {
			settings = (await this.client.query({ configfile: ['settings'] }))?.status?.configfile?.settings ?? null;
		} catch (err) {
			controlsError = toOctoPrintError(err).message;
		}
		return { profile: profileFromConfig(settings, objects), controls: macroControls(objects), controlsError };
	}

	/** Mainsail's presets from Moonraker's database, if Mainsail is in use. */
	async tempProfiles() {
		const res = await this.client.request('GET', '/server/database/item?namespace=mainsail&key=presets', { allow: [400, 404] });
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			return [];
		}
		const j = (await res.json().catch(() => null)) as { result?: unknown } | null;
		return presetsFromMainsail(j?.result, heaterMap(await this.objects().catch(() => [])));
	}

	/** FIRMWARE_RESTART: brings Klipper back after an error, or after the printer was powered on. */
	async connect() {
		await this.client.post('/printer/firmware_restart');
	}

	/** Klipper has no serial connection to drop. */
	async disconnect() {}

	/** RESTART: reloads the Klipper config (host only). */
	async restart() {
		await this.client.post('/printer/restart');
	}

	async cameras(baseUrl: string) {
		const res = await this.client.request('GET', '/server/webcams/list', { allow: [404] });
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			return [];
		}
		const j = (await res.json().catch(() => null)) as { result?: unknown } | null;
		return camerasFromWebcams(j?.result, baseUrl);
	}

	/** One page of Klipper's print history (`server.history.list`), newest first. */
	async historyPage(start: number, limit: number) {
		return this.client.get<{ count?: number; jobs?: unknown[] }>(`/server/history/list?start=${start}&limit=${limit}&order=desc`, { timeoutMs: 20_000 });
	}
}
