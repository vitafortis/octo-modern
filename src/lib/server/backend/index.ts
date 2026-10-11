/**
 * `backendFor(printer)`: the OctoPrint or Moonraker implementation of PrinterBackend for
 * a stored printer, with its decrypted key. Routes and background jobs use this; only
 * OctoPrint-specific features (timelapse, serial connection settings) reach for the
 * OctoPrint client directly, via `octoprintClient()`.
 */
import { config } from '../config.ts';
import { getApiKey, getPrinter } from '../store.ts';
import { OctoPrintError } from '../octoprint/errors.ts';
import { clientFor, printers } from '../octoprint/manager.ts';
import { moonrakerFor } from '../moonraker/client.ts';
import { MoonrakerBackend } from '../moonraker/backend.ts';
import { OctoPrintBackend } from './octoprint.ts';
import type { OctoPrintClient } from '../octoprint/client.ts';
import type { PrinterBackend } from './types.ts';
import { KIND_LABEL } from '#lib/printer-kind.ts';
import type { Printer } from '#lib/types.ts';

export type { PrinterBackend } from './types.ts';

function resolve(printer: Printer | string): Printer {
	const p = typeof printer === 'string' ? getPrinter(printer) : printer;
	if (!p) throw new OctoPrintError('Printer not found', { status: 404, code: 'NOT_FOUND' });
	return p;
}

export function backendFor(printer: Printer | string): PrinterBackend {
	const p = resolve(printer);
	if (p.kind === 'moonraker') {
		return new MoonrakerBackend(moonrakerFor(p, getApiKey(p.id) ?? '', config.requestTimeoutMs), { onSent: (script) => printers.feed(p.id)?.sent(script) });
	}
	return new OctoPrintBackend(clientFor(p));
}

/** The Moonraker backend of a Klipper printer (history import, firmware restart). */
export function moonrakerBackend(printer: Printer | string): MoonrakerBackend {
	const b = backendFor(printer);
	if (!(b instanceof MoonrakerBackend)) throw new OctoPrintError('Only for Klipper printers', { status: 400, code: 'NOT_SUPPORTED' });
	return b;
}

/** The OctoPrint client, for features only OctoPrint has; a clear 400 for Klipper printers. */
export function octoprintClient(printer: Printer | string, feature = 'This'): OctoPrintClient {
	const p = resolve(printer);
	if (p.kind !== 'octoprint') {
		throw new OctoPrintError(`${feature} isn’t available for ${KIND_LABEL[p.kind]} printers`, { status: 400, code: 'NOT_SUPPORTED', hint: 'It’s an OctoPrint feature without a Moonraker equivalent.' });
	}
	return clientFor(p);
}
