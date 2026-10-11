/**
 * Print history and timelapses from the browser: queries, and the actions with
 * their confirmations (the server insists on them too).
 */
import { api, ApiError, errorMessage } from './api.ts';
import { confirmAction, toast } from './state.svelte.ts';
import type { HistoryFilter, HistoryStats, PrintRecord, TimelapseConfig, TimelapseFile, TimelapseListing, UnrenderedTimelapse } from '#lib/history.ts';

/** Local calendar dates as the ISO instants the server compares with (start of `from`, end of `to`). */
export function filterQuery(f: HistoryFilter, extra: Record<string, string> = {}): URLSearchParams {
	const q = new URLSearchParams(extra);
	if (f.printer) q.set('printer', f.printer);
	if (f.result) q.set('result', f.result);
	if (f.from) q.set('from', new Date(`${f.from}T00:00:00`).toISOString());
	if (f.to) {
		const end = new Date(`${f.to}T00:00:00`);
		end.setDate(end.getDate() + 1);
		q.set('to', new Date(end.getTime() - 1).toISOString());
	}
	if (f.q?.trim()) q.set('q', f.q.trim());
	return q;
}

export const listHistory = (f: HistoryFilter, opts: { limit?: number; before?: number } = {}) =>
	api.get<{ items: PrintRecord[]; total: number }>(
		`/api/history?${filterQuery(f, { limit: String(opts.limit ?? 50), ...(opts.before ? { before: String(opts.before) } : {}) })}`
	);

export const historyStats = (f: HistoryFilter) => api.get<HistoryStats>(`/api/history/stats?${filterQuery(f)}`);

export const csvUrl = (f: HistoryFilter) => `/api/history/export.csv?${filterQuery(f)}`;

export const thumbnailUrl = (r: Pick<PrintRecord, 'id'>) => `/api/history/${r.id}/thumbnail`;

export async function saveNotes(r: PrintRecord, notes: string): Promise<PrintRecord | null> {
	try {
		return await api.patch<PrintRecord>(`/api/history/${r.id}`, { notes });
	} catch (err) {
		toast('error', 'Could not save the notes', errorMessage(err));
		return null;
	}
}

export async function deleteEntry(r: PrintRecord): Promise<boolean> {
	const ok = await confirmAction({
		title: 'Delete this history entry?',
		body: 'The entry, its picture and notes are removed from octo·modern. The file on OctoPrint stays.',
		detail: `${r.file} · ${new Date(r.startedAt).toLocaleString()}`,
		confirmLabel: 'Delete',
		danger: true
	});
	if (!ok) return false;
	try {
		await api.del(`/api/history/${r.id}`);
		toast('success', 'Entry deleted');
		return true;
	} catch (err) {
		toast('error', 'Could not delete the entry', errorMessage(err));
		return false;
	}
}

/** Prints the file again through the regular "print a file" route (it must still be on OctoPrint). */
export async function reprint(r: PrintRecord, printerName: string): Promise<boolean> {
	const ok = await confirmAction({ title: `Print ${r.file} again?`, body: `Starts the print on ${printerName} right away.`, detail: `${r.origin === 'sdcard' ? 'SD card' : 'local'}: ${r.path}`, confirmLabel: 'Print' });
	if (!ok) return false;
	const url = `/api/printers/${encodeURIComponent(r.printerId)}/files/select`;
	const body = { origin: r.origin, path: r.path, print: true };
	try {
		try {
			await api.post(url, body);
		} catch (err) {
			// The server may ask first (e.g. the active spool won't last).
			if (!(err instanceof ApiError && err.status === 409 && err.detail?.confirmRequired)) throw err;
			if (!(await confirmAction({ title: err.detail.title ?? 'Are you sure?', body: err.message, confirmLabel: err.detail.confirmLabel ?? 'Print anyway', danger: true }))) return false;
			await api.post(url, { ...body, confirm: true });
		}
		toast('success', 'Print started', r.file);
		return true;
	} catch (err) {
		const gone = err instanceof ApiError && err.status === 404;
		toast('error', 'Could not start the print', gone ? 'The file is no longer on OctoPrint.' : errorMessage(err));
		return false;
	}
}

export async function importHistory(printer?: string): Promise<number | null> {
	try {
		const r = await api.post<{ imported: number; results: { name: string; error?: string }[] }>('/api/history/import', printer ? { printer } : {});
		const failed = r.results.filter((x) => x.error);
		if (failed.length) toast('error', `Couldn’t reach ${failed.map((f) => f.name).join(', ')}`, failed[0].error);
		toast('success', r.imported ? `Imported ${r.imported} earlier print${r.imported === 1 ? '' : 's'}` : 'Nothing new to import');
		return r.imported;
	} catch (err) {
		toast('error', 'Import failed', errorMessage(err));
		return null;
	}
}

// --- timelapse -------------------------------------------------------------------

const tl = (id: string) => `/api/printers/${encodeURIComponent(id)}/timelapse`;

export const listTimelapses = (printerId: string) => api.get<TimelapseListing>(tl(printerId));

export const timelapseUrl = (printerId: string, name: string, download = false) => `${tl(printerId)}/file?name=${encodeURIComponent(name)}${download ? '&download=1' : ''}`;

export async function saveTimelapseConfig(printerId: string, config: TimelapseConfig): Promise<TimelapseListing | null> {
	try {
		const r = await api.post<TimelapseListing>(tl(printerId), config);
		toast('success', 'Timelapse settings saved');
		return r;
	} catch (err) {
		toast('error', 'Could not save the timelapse settings', errorMessage(err));
		return null;
	}
}

export async function deleteTimelapse(printerId: string, f: TimelapseFile): Promise<boolean> {
	const ok = await confirmAction({ title: 'Delete this timelapse?', body: 'The video is deleted from OctoPrint. This can’t be undone.', detail: f.name, confirmLabel: 'Delete', danger: true });
	if (!ok) return false;
	try {
		await api.del(`${tl(printerId)}/file?name=${encodeURIComponent(f.name)}&confirm=1`);
		toast('success', 'Timelapse deleted', f.name);
		return true;
	} catch (err) {
		toast('error', 'Could not delete the timelapse', errorMessage(err));
		return false;
	}
}

export async function renderTimelapse(printerId: string, u: UnrenderedTimelapse): Promise<boolean> {
	try {
		await api.post(`${tl(printerId)}/unrendered`, { name: u.name });
		toast('info', 'Rendering…', `${u.name}: OctoPrint renders it in the background.`);
		return true;
	} catch (err) {
		toast('error', 'Could not start rendering', errorMessage(err));
		return false;
	}
}

export async function deleteUnrendered(printerId: string, u: UnrenderedTimelapse): Promise<boolean> {
	const ok = await confirmAction({ title: 'Delete these frames?', body: 'The captured frames are deleted from OctoPrint; this timelapse can’t be rendered afterwards.', detail: u.name, confirmLabel: 'Delete', danger: true });
	if (!ok) return false;
	try {
		await api.del(`${tl(printerId)}/unrendered?name=${encodeURIComponent(u.name)}&confirm=1`);
		toast('success', 'Frames deleted', u.name);
		return true;
	} catch (err) {
		toast('error', 'Could not delete the frames', errorMessage(err));
		return false;
	}
}
