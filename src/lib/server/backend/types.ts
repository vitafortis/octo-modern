/**
 * The printer backend: what the rest of octo·modern asks of a printer server, whatever
 * runs it. `backendFor(printer)` (./index.ts) returns the OctoPrint or the Moonraker
 * (Klipper) implementation. Live state (the snapshot, temperature history, terminal,
 * events) doesn't go through here: the manager (octoprint/manager.ts) runs a push
 * session per kind and feeds the same LiveModel.
 *
 * Paths are relative to the printer's file storage (OctoPrint's `local` origin,
 * Moonraker's `gcodes` root); `origin` is `local` except for OctoPrint's SD card.
 */
import type { ControlAction } from '../control-actions.ts';
import type { TempProfile } from '../octoprint/parse.ts';
import type { Camera } from '../octoprint/webcam.ts';
import type { PrinterProfile } from '#lib/control/profile.ts';
import type { CustomControl } from '#lib/control/custom.ts';
import type { JobInfo, PrinterState } from '#lib/printer.ts';
import type { FileListing, PrinterKind } from '#lib/types.ts';

export type JobCommand = 'start' | 'pause' | 'resume' | 'cancel' | 'restart';
export type Origin = 'local' | 'sdcard';

export interface UploadOptions {
	/** A multipart/form-data body with the file in the `file` field (as browsers send it). */
	body: ReadableStream<Uint8Array>;
	contentType: string;
	/** Byte length of `body` (both servers need it). */
	length: number;
	origin?: Origin;
	/** Target folder ('' = top level). */
	folder?: string;
	select?: boolean;
	print?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** The file's name, for the result when the server doesn't report the stored path. */
	name?: string;
}

export interface UploadResult {
	/** Where the server stored it, when it says. */
	path: string | null;
	selected: boolean;
	printing: boolean;
}

/** What the history, queue and filament checks need to know about one file. */
export interface FileDetails {
	size: number | null;
	/** Filament from the analysis or slicer metadata, mm summed over tools. */
	filamentMm: number | null;
	/** Filament per tool number, mm. */
	perTool: Record<number, number>;
	estimatedS: number | null;
	/** Thumbnail source for …/files/thumbnail?src= (kind-specific, validated there). */
	thumbnail: string | null;
	/** The server's record of the file's last print (epoch ms), if it keeps one. */
	last: { date: number; success: boolean; printTime: number | null } | null;
}

export interface ControlInfo {
	profile: PrinterProfile;
	controls: CustomControl[];
	controlsError: string | null;
}

export interface PrinterBackend {
	readonly kind: PrinterKind;
	/** host[:port], for error messages. */
	readonly host: string;

	/** Asks the server for its state now (the live snapshot can trail by a second or two). */
	status(): Promise<{ state: PrinterState | null; job: JobInfo | null }>;
	jobCommand(command: JobCommand): Promise<void>;
	/** Selects a file, and prints it when `print` (Moonraker can only print). */
	selectFile(origin: Origin, path: string, print: boolean): Promise<void>;

	files(): Promise<FileListing>;
	deleteFile(origin: Origin, path: string): Promise<void>;
	createFolder(name: string, parent: string): Promise<void>;
	/** Null when the file isn't there or can't be read. */
	fileDetails(origin: Origin, path: string): Promise<FileDetails | null>;
	/** Size of a file in local storage; null when it isn't there, -1 when unknown. */
	fileSize(path: string): Promise<number | null>;
	upload(opts: UploadOptions): Promise<UploadResult>;
	/** The raw file (local storage) as the server sends it; 206, 404 and 416 resolve. */
	download(path: string, opts: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }): Promise<Response>;
	/** Whether `src` is a thumbnail path this kind serves (nothing else is proxied). */
	thumbnailSource(src: unknown): string | null;
	thumbnail(src: string, opts?: { timeoutMs?: number }): Promise<Response>;

	setTargets(targets: Record<string, number>): Promise<void>;
	sendCommands(commands: string[]): Promise<void>;
	emergencyStop(): Promise<void>;
	control(action: ControlAction): Promise<void>;
	controlInfo(): Promise<ControlInfo>;
	tempProfiles(): Promise<TempProfile[]>;

	/** OctoPrint: connect the serial port. Klipper: FIRMWARE_RESTART (gets an MCU back after power-on). */
	connect(opts?: { port?: string; baudrate?: number; printerProfile?: string; save?: boolean; autoconnect?: boolean }): Promise<void>;
	/** OctoPrint: disconnect the serial port. Klipper: nothing to do. */
	disconnect(): Promise<void>;
	/** Cameras the server knows of (the admin's override URL is handled by the caller). */
	cameras(baseUrl: string): Promise<Camera[]>;
}
