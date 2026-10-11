/**
 * The OctoPrint backend: a thin layer over OctoPrintClient and the OctoPrint helpers
 * that existed before Klipper support (same requests, same behaviour).
 */
import { encodePath, OctoPrintClient } from '../octoprint/client.ts';
import { httpError, toOctoPrintError } from '../octoprint/errors.ts';
import { parseFileDetails, parseFileListing, safeThumbnail } from '../octoprint/files.ts';
import { parseJobResponse, parseTempProfiles } from '../octoprint/parse.ts';
import { streamRequest } from '../octoprint/transport.ts';
import { camerasFromSettings } from '../octoprint/webcam.ts';
import { performControl, type ControlAction } from '../control-actions.ts';
import { currentProfile } from '#lib/control/profile.ts';
import { parseCustomControls } from '#lib/control/custom.ts';
import type { ControlInfo, FileDetails, JobCommand, Origin, PrinterBackend, UploadOptions, UploadResult } from './types.ts';

export class OctoPrintBackend implements PrinterBackend {
	readonly kind = 'octoprint' as const;
	readonly client: OctoPrintClient;

	constructor(client: OctoPrintClient) {
		this.client = client;
	}

	get host() {
		return this.client.host;
	}

	async status() {
		const r = parseJobResponse(await this.client.job());
		return { state: r.state?.state ?? null, job: r.job };
	}

	jobCommand(command: JobCommand) {
		if (command === 'pause') return this.client.jobCommand('pause', 'pause');
		if (command === 'resume') return this.client.jobCommand('pause', 'resume');
		return this.client.jobCommand(command);
	}

	selectFile(origin: Origin, path: string, print: boolean) {
		return this.client.selectFile(origin, path, print);
	}

	async files() {
		return parseFileListing(await this.client.files());
	}

	deleteFile(origin: Origin, path: string) {
		return this.client.deleteFile(origin, path);
	}

	async createFolder(name: string, parent: string) {
		await this.client.createFolder(name, parent);
	}

	async fileDetails(origin: Origin, path: string): Promise<FileDetails | null> {
		try {
			return parseFileDetails(await this.client.get<unknown>(`/api/files/${origin === 'sdcard' ? 'sdcard' : 'local'}/${encodePath(path)}`, { timeoutMs: 6_000 }));
		} catch {
			return null;
		}
	}

	async fileSize(path: string): Promise<number | null> {
		const res = await this.client.request('GET', `/api/files/local/${encodePath(path)}`, { allow: [404] });
		if (res.status === 404) {
			await res.body?.cancel().catch(() => {});
			return null;
		}
		const j = (await res.json().catch(() => null)) as { size?: unknown } | null;
		return typeof j?.size === 'number' ? j.size : -1;
	}

	/**
	 * Streams the multipart body to POST /api/files/<origin>; OctoPrint reads `path`,
	 * `select` and `print` from the query like form fields.
	 */
	async upload(o: UploadOptions): Promise<UploadResult> {
		const origin = o.origin === 'sdcard' ? 'sdcard' : 'local';
		const q = new URLSearchParams();
		if (o.folder) q.set('path', o.folder);
		if (o.select || o.print) q.set('select', 'true');
		if (o.print) q.set('print', 'true');
		let res: { status: number; text: string };
		try {
			res = await streamRequest(this.client.url(`/api/files/${origin}${q.size ? `?${q}` : ''}`), {
				method: 'POST',
				headers: { 'X-Api-Key': this.client.target.apiKey, accept: 'application/json', 'content-type': o.contentType, 'content-length': String(o.length) },
				body: o.body,
				verifyTls: this.client.target.verifyTls,
				signal: o.signal,
				timeoutMs: o.timeoutMs ?? 5 * 60_000
			});
		} catch (err) {
			throw toOctoPrintError(err, this.client.host);
		}
		if (res.status < 200 || res.status >= 300) throw httpError(res.status, `/api/files/${origin}`, res.text);
		const r = (JSON.parse(res.text || '{}') ?? {}) as { effectivePrint?: boolean; effectiveSelect?: boolean; files?: Record<string, { path?: string }> };
		return { path: r.files?.[origin]?.path ?? null, printing: !!r.effectivePrint, selected: !!r.effectiveSelect };
	}

	download(path: string, opts: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }) {
		return this.client.request('GET', `/downloads/files/local/${encodePath(path)}`, {
			headers: { accept: '*/*', ...opts.headers },
			allow: [206, 404, 416],
			timeoutMs: opts.timeoutMs ?? 60 * 60_000,
			signal: opts.signal
		});
	}

	thumbnailSource(src: unknown) {
		return safeThumbnail(src);
	}

	thumbnail(src: string, opts: { timeoutMs?: number } = {}) {
		return this.client.request('GET', `/${src}`, { headers: { accept: 'image/*' }, timeoutMs: opts.timeoutMs });
	}

	async setTargets(targets: Record<string, number>) {
		for (const [heater, value] of Object.entries(targets)) await this.client.setTarget(heater, value);
	}

	sendCommands(commands: string[]) {
		return this.client.sendCommands(commands);
	}

	emergencyStop() {
		return this.client.sendCommands(['M112']);
	}

	control(action: ControlAction) {
		return performControl(this.client, action);
	}

	async controlInfo(): Promise<ControlInfo> {
		const [profiles, custom] = await Promise.allSettled([this.client.get<unknown>('/api/printerprofiles'), this.client.get<unknown>('/api/printer/command/custom')]);
		if (profiles.status === 'rejected') throw profiles.reason;
		return {
			profile: currentProfile(profiles.value),
			controls: custom.status === 'fulfilled' ? parseCustomControls(custom.value) : [],
			controlsError: custom.status === 'rejected' ? toOctoPrintError(custom.reason).message : null
		};
	}

	async tempProfiles() {
		return parseTempProfiles(await this.client.settings());
	}

	connect(opts: { port?: string; baudrate?: number; printerProfile?: string; save?: boolean; autoconnect?: boolean } = {}) {
		return this.client.connect(opts);
	}

	disconnect() {
		return this.client.disconnect();
	}

	async cameras(baseUrl: string) {
		return camerasFromSettings(await this.client.settings(), baseUrl);
	}
}
