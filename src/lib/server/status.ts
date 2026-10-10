/**
 * Printer status for dashboards (GET /api/status…), built from the live state the
 * manager already keeps, so frequent polling never reaches OctoPrint more than the
 * regular status poll does.
 */
import { printers } from './octoprint/manager.ts';
import { getPrinter, listPrinters } from './store.ts';
import { filamentMeters, heaterKeys, jobActive, progressPercent, STATE_LABEL, type LiveSnapshot, type PrinterState } from '#lib/printer.ts';
import type { Printer } from '#lib/types.ts';

export interface StatusItem {
	id: string;
	name: string;
	/** octo·modern's state: offline, disconnected, operational, printing, paused, error, … */
	state: PrinterState;
	/** Human label, e.g. "Printing". */
	stateLabel: string;
	/** OctoPrint reachable. */
	online: boolean;
	printing: boolean;
	/** 0–100 while a job runs, else null. */
	progress: number | null;
	file: string | null;
	printTimeSeconds: number | null;
	printTimeLeftSeconds: number | null;
	/** ISO time the job should end. */
	eta: string | null;
	filamentMeters: number | null;
	temperatures: Record<string, { actual: number | null; target: number | null }>;
	version: string | null;
	lastUpdatedAt: string | null;
	/** Short error code when unreachable (e.g. ECONNREFUSED); never the full message, which can name hosts. */
	error?: string;
	/** Only for tokens created with "include addresses". */
	url?: string;
}

export interface StatusSummary {
	printers: number;
	online: number;
	printing: number;
	checkedAt: string;
	items: StatusItem[];
}

export function statusItem(p: Printer, s: LiveSnapshot, includeAddresses: boolean): StatusItem {
	const left = s.progress?.printTimeLeft ?? null;
	const active = jobActive(s.state);
	const item: StatusItem = {
		id: p.id,
		name: p.name,
		state: s.state,
		stateLabel: STATE_LABEL[s.state],
		online: s.state !== 'offline' && s.state !== 'unknown',
		printing: s.state === 'printing',
		progress: progressPercent(s) == null ? null : Math.round(progressPercent(s)! * 10) / 10,
		file: active ? (s.job?.file?.display ?? null) : null,
		printTimeSeconds: active ? (s.progress?.printTime ?? null) : null,
		printTimeLeftSeconds: active ? left : null,
		eta: active && left != null ? new Date(Date.now() + left * 1000).toISOString() : null,
		filamentMeters: active ? filamentMeters(s.job) : null,
		temperatures: Object.fromEntries(heaterKeys(s.temps).map((k) => [k, s.temps[k]])),
		version: s.version ?? p.octoprintVersion,
		lastUpdatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null
	};
	if (s.state === 'offline' && s.problem) item.error = s.problem.code ?? 'error';
	if (includeAddresses) item.url = p.baseUrl;
	return item;
}

export async function statusSummary(opts: { includeAddresses: boolean }): Promise<StatusSummary> {
	const list = listPrinters();
	const snaps = await printers.snapshots(list.map((p) => p.id));
	const items = list.map((p, i) => statusItem(p, snaps[i], opts.includeAddresses));
	return {
		printers: items.length,
		online: items.filter((i) => i.online).length,
		printing: items.filter((i) => i.printing).length,
		checkedAt: new Date().toISOString(),
		items
	};
}

export async function printerStatus(id: string, opts: { includeAddresses: boolean }): Promise<StatusItem | null> {
	const p = getPrinter(id);
	if (!p) return null;
	const [s] = await printers.snapshots([id]);
	return s ? statusItem(p, s, opts.includeAddresses) : null;
}

// --- badge ------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Rough Verdana 11px advance, as shields.io-style badges are sized. */
const textWidth = (s: string) => Math.ceil([...s].reduce((w, c) => w + (/[iljI.,:;'|! ]/.test(c) ? 3.5 : /[mwMW@%]/.test(c) ? 9.5 : /[A-Z0-9]/.test(c) ? 7.5 : 6.5), 0));

const BADGE_COLORS: Record<string, string> = { success: '#3fb950', primary: '#8b5cf6', warning: '#d29922', danger: '#e5534b', muted: '#9f9f9f' };

/** A shields.io-style flat badge: `name | printing 42%` (violet), `ready` (green), `unreachable` (red). */
export function statusBadge(label: string, item: Pick<StatusItem, 'state' | 'stateLabel' | 'progress'> | null): string {
	let value = 'unknown';
	let color = BADGE_COLORS.muted;
	if (item) {
		value = item.stateLabel.toLowerCase() + (item.progress != null ? ` ${Math.round(item.progress)}%` : '');
		color =
			item.state === 'operational'
				? BADGE_COLORS.success
				: item.state === 'printing' || item.state === 'finishing'
					? BADGE_COLORS.primary
					: item.state === 'paused' || item.state === 'pausing' || item.state === 'cancelling'
						? BADGE_COLORS.warning
						: item.state === 'error' || item.state === 'offline'
							? BADGE_COLORS.danger
							: BADGE_COLORS.muted;
	}
	const lw = textWidth(label) + 12;
	const vw = textWidth(value) + 12;
	const w = lw + vw;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}
