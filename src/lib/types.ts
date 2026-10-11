/**
 * Types shared by the server and the browser. Live printer state lives in printer.ts.
 */

/**
 * - `admin`: everything — servers, users, settings, and printer control
 * - `operator`: controls the printers they can see (jobs, temperatures, files, terminal)
 * - `viewer`: watches only (status, webcam, temperatures, history)
 */
export type Role = 'admin' | 'operator' | 'viewer';

export const ROLES: Role[] = ['admin', 'operator', 'viewer'];

export function isRole(v: unknown): v is Role {
	return v === 'admin' || v === 'operator' || v === 'viewer';
}

/**
 * What runs the printer: an OctoPrint server, or Klipper behind Moonraker (the API
 * Mainsail and Fluidd use). Everything else in the app works through the printer
 * backend (src/lib/server/backend), so most features don't care which.
 */
export type PrinterKind = 'octoprint' | 'moonraker';

export const PRINTER_KINDS: PrinterKind[] = ['octoprint', 'moonraker'];

export function isPrinterKind(v: unknown): v is PrinterKind {
	return v === 'octoprint' || v === 'moonraker';
}

/** What an admin enters for an OctoPrint server. */
export interface PrinterInput {
	name: string;
	/** OctoPrint or Moonraker (Klipper). Defaults to OctoPrint on create; omit on update to keep it. */
	kind?: PrinterKind;
	/** OctoPrint's base URL, including any path prefix (e.g. https://host/octoprint). */
	baseUrl: string;
	/** Application Key or user API key (optional for Moonraker). Omit on update to keep the stored one. */
	apiKey?: string;
	/** Verify the server's TLS certificate (turn off for self-signed certificates). */
	verifyTls: boolean;
	/** Overrides the webcam snapshot/stream URL OctoPrint reports. */
	webcamUrl: string | null;
	color: string;
}

/** A stored OctoPrint server as the browser sees it — never includes the API key. */
export interface Printer {
	id: string;
	name: string;
	kind: PrinterKind;
	baseUrl: string;
	hasApiKey: boolean;
	verifyTls: boolean;
	webcamUrl: string | null;
	color: string;
	createdAt: string;
	updatedAt: string;
	/** Last time octo·modern reached the server. */
	lastSeenAt: string | null;
	/** OctoPrint (or Klipper/Moonraker) version from the last successful contact. */
	octoprintVersion: string | null;
	/** What the signed-in user may do (set on responses to the browser). */
	access?: PrinterAccess;
}

export interface PrinterAccess {
	/** Start/pause/cancel jobs, jog, set temperatures, upload and print files, use the terminal. */
	control: boolean;
}

export interface User {
	id: string;
	email: string;
	name: string | null;
	role: Role;
	/** Has a local password (can use the password form). */
	hasPassword: boolean;
	/** Linked to an SSO identity. */
	sso: boolean;
	disabled: boolean;
	/** Every printer, or only granted ones. Admins always see every printer. */
	printerAccess: 'all' | 'selected';
	createdAt: string;
	lastLoginAt: string | null;
}

/** What the browser knows about the current session. */
export interface Viewer {
	email: string;
	name: string | null;
	role: Role;
	hasPassword: boolean;
	sso: boolean;
}

export interface AuditEvent {
	id: number;
	at: string;
	userId: string | null;
	userEmail: string | null;
	action: string;
	printerId: string | null;
	printerName: string | null;
	detail: string | null;
	ip: string | null;
}

/** An error from OctoPrint or the network, with a hint for fixing it. */
export interface ProblemInfo {
	message: string;
	/** Short machine-readable code: ECONNREFUSED, HTTP_403, TIMEOUT… */
	code?: string;
	hint?: string;
	status?: number;
}

/** Result of "Test connection". */
export type TestResult =
	| {
			ok: true;
			/** What answered (Moonraker also emulates parts of OctoPrint's API, so it's probed first). */
			kind?: PrinterKind;
			version: string;
			apiVersion: string | null;
			/** The user the API key belongs to. */
			user: string | null;
			permissions: string[];
			/** Permissions octo·modern uses that the key lacks. */
			missing: string[];
			latencyMs: number;
	  }
	| { ok: false; error: ProblemInfo };

/** A file or folder on OctoPrint (local storage or the printer's SD card). */
export interface FileEntry {
	origin: 'local' | 'sdcard';
	/** Path within its origin, e.g. `parts/benchy.gcode`. */
	path: string;
	name: string;
	/** Display name (OctoPrint keeps the original name of uploads with special characters). */
	display: string;
	type: 'folder' | 'machinecode' | 'model' | 'other';
	size: number | null;
	/** Upload time, epoch seconds. */
	date: number | null;
	/** From OctoPrint's G-code analysis, seconds. */
	estimatedPrintTime: number | null;
	/** Filament from the analysis, mm summed over tools. */
	filamentMm: number | null;
	/** Relative thumbnail path from a slicer-thumbnail plugin, for …/files/thumbnail?src=. */
	thumbnail: string | null;
	prints: { success: number; failure: number; lastSuccess: boolean | null; lastDate: number | null } | null;
	children?: FileEntry[];
}

export interface FileListing {
	files: FileEntry[];
	/** Free and total bytes of OctoPrint's upload folder. */
	free: number | null;
	total: number | null;
}
