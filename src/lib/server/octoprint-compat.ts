/**
 * Enough of OctoPrint's REST API for slicers to upload to octo·modern as if it were an
 * OctoPrint server: PrusaSlicer, OrcaSlicer (and other Slic3r forks) and Cura's
 * OctoPrint Connection plugin.
 *
 * It lives under its own prefix, `/octoprint/api/…` (the slicer's host is
 * `http://<octo·modern>/octoprint`), because octo·modern's own `/api/…` is a different,
 * session-authenticated API. Requests authenticate with an upload key (an `ocm_` API
 * token with scope `upload`) in `X-Api-Key`, like OctoPrint keys; the key decides where
 * files go: a library folder, the print queue, or straight to one printer.
 *
 * What slicers send (from their sources):
 * - test / connect: `GET api/version` (PrusaSlicer and OrcaSlicer require `text` to start
 *   with "OctoPrint"); Cura also reads `api/settings`, `api/printerprofiles`, and polls
 *   `api/printer`, `api/job` and `api/connection`.
 * - upload: `POST api/files/local`, multipart: `file` (the G-code, with its name), and
 *   text fields `print` ("true"/"false") and `path` (PrusaSlicer, OrcaSlicer) or
 *   `select` and `print` (Cura).
 */
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { json } from '@sveltejs/kit';
import { audit } from './permissions.ts';
import { refreshSoon } from './control.ts';
import { backendFor } from './backend/index.ts';
import { canReach } from '#lib/printer-kind.ts';
import { bytesLabel } from './octoprint/files-util.ts';
import { getPrinter } from './store.ts';
import { getSource } from './library/sources.ts';
import { withDriver } from './library/service.ts';
import { toLibraryError } from './library/drivers.ts';
import { boundaryOf, MultipartError, parseMultipart } from './multipart.ts';
import { tempUploadPath, uploadFileToPrinter } from './queue/files.ts';
import { addUploadJob, uploadName } from './queue/service.ts';
import { cleanRelPath, isPrintable, joinPath } from '#lib/library.ts';
import type { TokenPrincipal } from './api-tokens.ts';
import type { UploadTarget } from '#lib/queue.ts';

/** The OctoPrint version octo·modern answers with (slicers check the API, not this). */
export const COMPAT_VERSION = '1.10.3';
export const COMPAT_PREFIX = '/octoprint';

/** OctoPrint's error shape. */
export const opError = (status: number, error: string) => json({ error }, { status });

export function versionInfo() {
	return { api: '0.1', server: COMPAT_VERSION, text: `OctoPrint ${COMPAT_VERSION} (octo·modern)` };
}

/** Problems with a key's destination, e.g. a removed source (null when it's usable). */
export function uploadTargetProblem(t: UploadTarget): string | null {
	switch (t.kind) {
		case 'library': {
			const src = getSource(t.sourceId);
			if (!src) return 'The library source no longer exists';
			if (!src.writable) return `${src.name} is read-only; allow writing in its settings`;
			return null;
		}
		case 'queue':
			return t.printerId && !getPrinter(t.printerId) ? 'The printer no longer exists' : null;
		case 'printer': {
			const p = getPrinter(t.printerId);
			if (!p) return 'The printer no longer exists';
			return canReach(p) ? null : `${p.name} has no OctoPrint API key saved`;
		}
	}
}

/** A human description of a destination, for the token list and the audit log. */
export function describeUploadTarget(t: UploadTarget): string {
	switch (t.kind) {
		case 'library': {
			const src = getSource(t.sourceId);
			return `library ${src?.name ?? '(removed)'}${t.folder ? ` / ${t.folder}` : ''}`;
		}
		case 'queue':
			return t.printerId ? `queue → ${getPrinter(t.printerId)?.name ?? '(removed printer)'}` : `queue → any printer${t.tags.length ? ` with ${t.tags.join(', ')}` : ''}`;
		case 'printer':
			return `${getPrinter(t.printerId)?.name ?? '(removed printer)'}${t.allowPrint ? ' (may start prints)' : ''}`;
	}
}

const truthy = (v: string | null | undefined) => /^(true|yes|on|1)$/i.test((v ?? '').trim());

/** An OctoPrint-style upload answer. */
function uploaded(base: string, path: string, name: string, opts: { select: boolean; print: boolean }) {
	const resource = `${base}/api/files/local/${path.split('/').map(encodeURIComponent).join('/')}`;
	return json(
		{
			done: true,
			files: { local: { name, display: name, origin: 'local', path, refs: { resource, download: resource } } },
			effectiveSelect: opts.select,
			effectivePrint: opts.print
		},
		{ status: 201, headers: { location: resource } }
	);
}

/** POST /octoprint/api/files/local: a slicer upload, sent where the key says. */
export async function handleUpload(request: Request, url: URL, principal: TokenPrincipal, ctx: { ip?: string; base: string }): Promise<Response> {
	const target = principal.options.upload;
	if (!target) return opError(403, 'This key can’t upload');
	const boundary = boundaryOf(request.headers.get('content-type'));
	if (!boundary || !request.body) return opError(400, 'Expected a multipart/form-data upload with a "file" part');
	const problem = uploadTargetProblem(target);
	if (problem) return opError(409, `Uploads for this key can’t be stored: ${problem}`);

	const tmp = await tempUploadPath();
	let keepTmp = false;
	try {
		let parsed;
		try {
			parsed = await parseMultipart(request.body as unknown as AsyncIterable<Uint8Array>, boundary, tmp);
		} catch (err) {
			return opError(400, err instanceof MultipartError ? err.message : 'Couldn’t read the upload');
		}
		const { fields, file } = parsed;
		if (!file || file.field !== 'file') return opError(400, 'No file to upload (expected a "file" part)');
		const name = uploadName(file.filename);
		if (!isPrintable(name)) return opError(415, 'Only G-code files can be uploaded (.gcode, .gco, .g, .bgcode)');
		const field = (k: string) => fields[k] ?? url.searchParams.get(k);
		const print = truthy(field('print'));
		const select = truthy(field('select')) || print;
		let folder = '';
		try {
			folder = cleanRelPath(field('path') ?? '');
		} catch {
			folder = '';
		}
		const locals = { user: null, ip: ctx.ip };
		const who = `slicer key “${principal.name}”`;
		const size = bytesLabel(file.size);

		switch (target.kind) {
			case 'library': {
				const src = getSource(target.sourceId)!;
				const dest = joinPath(joinPath(target.folder, folder), name);
				try {
					await withDriver(src, (d) => d.write(dest, createReadStream(tmp), file.size));
				} catch (err) {
					const e = toLibraryError(err);
					return opError(e.status && e.status < 500 ? e.status : 502, `Couldn’t save to ${src.name}: ${e.message}`);
				}
				audit(locals, 'upload.library', { detail: `${who}: ${name} → ${src.name}: ${dest} (${size})` });
				return uploaded(ctx.base, dest, name, { select: false, print: false });
			}
			case 'queue': {
				const job = await addUploadJob({
					tmpFile: tmp,
					filename: name,
					size: file.size,
					printerId: target.printerId,
					tags: target.tags,
					copies: 1,
					createdById: null,
					createdBy: `Key: ${principal.name}`
				});
				keepTmp = true;
				const printer = target.printerId ? getPrinter(target.printerId) : undefined;
				audit(locals, 'queue.add', { printer, detail: `${who}: ${job.name} (${size}) → ${printer ? printer.name : `any printer${target.tags.length ? ` with ${target.tags.join(', ')}` : ''}`}` });
				return uploaded(ctx.base, name, name, { select: false, print: false });
			}
			case 'printer': {
				const printer = getPrinter(target.printerId)!;
				const doPrint = print && target.allowPrint;
				const r = await uploadFileToPrinter(backendFor(printer), { file: tmp, name, folder, select: select && target.allowPrint, print: doPrint });
				audit(locals, 'file.upload', {
					printer,
					detail: `${who}: ${r.path} (${size})${print ? (!target.allowPrint ? ', print requested but this key may not start prints' : r.printing ? ', printing' : ', print requested but the printer wasn’t ready') : ''}`
				});
				if (r.printing) audit(locals, 'job.start', { printer, detail: r.path });
				refreshSoon(printer.id);
				return uploaded(ctx.base, r.path, name, { select: r.selected, print: r.printing });
			}
		}
		return opError(500, 'Unknown destination');
	} catch (err) {
		const e = err as { message?: string; hint?: string; status?: number };
		return opError(502, `${e.message ?? 'Upload failed'}${e.hint ? `. ${e.hint}` : ''}`);
	} finally {
		if (!keepTmp) await rm(tmp, { force: true }).catch(() => {});
	}
}

// --- read-only answers (what Cura's plugin asks for) ---------------------------------------

const FLAGS = { operational: true, ready: true, printing: false, paused: false, pausing: false, resuming: false, cancelling: false, finishing: false, error: false, closedOrError: false, sdReady: false };

/** The answer for a GET under /octoprint/api/, or null for "not found". */
export function readOnly(path: string, principal: TokenPrincipal): unknown | null {
	switch (path) {
		case 'version':
			return versionInfo();
		case 'server':
			return { version: COMPAT_VERSION, safemode: null };
		case 'currentuser':
			return { name: principal.name, permissions: [], groups: [] };
		case 'settings':
			return {
				api: { allowCrossOrigin: false },
				feature: { sdSupport: false },
				webcam: { webcamEnabled: false, streamUrl: '', snapshotUrl: '', flipH: false, flipV: false, rotate90: false },
				plugins: {}
			};
		case 'printerprofiles':
			return {
				profiles: {
					_default: {
						id: '_default',
						name: 'octo·modern',
						model: 'octo·modern',
						current: true,
						default: true,
						heatedBed: true,
						heatedChamber: false,
						volume: { width: 250, depth: 250, height: 250, formFactor: 'rectangular', origin: 'lowerleft' },
						extruder: { count: 1, nozzleDiameter: 0.4, sharedNozzle: false }
					}
				}
			};
		case 'printer':
			return { state: { text: 'Operational', flags: FLAGS }, temperature: {}, sd: { ready: false } };
		case 'job':
			return {
				job: { file: { name: null, path: null, display: null, origin: null, size: null, date: null }, estimatedPrintTime: null, filament: null, user: null },
				progress: { completion: null, filepos: null, printTime: null, printTimeLeft: null, printTimeLeftOrigin: null },
				state: 'Operational'
			};
		case 'connection':
			return {
				current: { state: 'Operational', port: 'octo-modern', baudrate: 0, printerProfile: '_default' },
				options: { ports: ['octo-modern'], baudrates: [], printerProfiles: [{ id: '_default', name: 'octo·modern' }], portPreference: null, baudratePreference: null, printerProfilePreference: '_default', autoconnect: false }
			};
		case 'files':
		case 'files/local':
			// Uploads only: nothing to list (Cura checks for an existing file of the same name).
			return { files: [], free: 1e12, total: 1e12 };
		default:
			return null;
	}
}
