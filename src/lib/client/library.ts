/**
 * The library from the browser: sources, folders, search, metadata and thumbnails,
 * sending files to printers (with the overwrite and busy-printer questions the server
 * asks), and saving printer files back to the NAS.
 */
import { api, ApiError, errorMessage } from './api.ts';
import { confirmAction, toast } from './state.svelte.ts';
import type { GcodeMeta, LibraryListing, LibrarySearch, LibrarySend, LibrarySourceSummary } from '#lib/library.ts';
import { fileVersion, type LibraryEntry } from '#lib/library.ts';

const base = (id: string) => `/api/library/${encodeURIComponent(id)}`;

export const listSources = () => api.get<LibrarySourceSummary[]>('/api/library/sources');

export const listFolder = (sourceId: string, path: string, signal?: AbortSignal) =>
	api.get<LibraryListing>(`${base(sourceId)}/list?${new URLSearchParams({ path })}`, signal);

export const searchLibrary = (sourceId: string, path: string, q: string, all: boolean, signal?: AbortSignal) =>
	api.get<LibrarySearch>(`${base(sourceId)}/search?${new URLSearchParams({ path, q, ...(all ? { all: '1' } : {}) })}`, signal);

export const fileMeta = (sourceId: string, path: string) => api.get<{ meta: GcodeMeta; version: string }>(`${base(sourceId)}/meta?${new URLSearchParams({ path })}`);

export const thumbnailUrl = (sourceId: string, e: Pick<LibraryEntry, 'path' | 'size' | 'mtime'>) =>
	`${base(sourceId)}/thumbnail?${new URLSearchParams({ path: e.path, v: fileVersion(e) })}`;

/**
 * Sends a file to a printer, asking before replacing a file of the same name and when
 * the printer can't start printing now. Resolves with the transfer, or null if the user
 * backed out or it failed (a toast says why).
 */
export async function sendToPrinter(
	sourceId: string,
	opts: { path: string; printerId: string; printerName: string; folder: string; print: boolean }
): Promise<LibrarySend | null> {
	const req: Record<string, unknown> = { path: opts.path, printerId: opts.printerId, folder: opts.folder, print: opts.print };
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			return await api.post<LibrarySend>(`${base(sourceId)}/send`, req);
		} catch (err) {
			const d = err instanceof ApiError ? (err.detail as { exists?: boolean; target?: string; confirmRequired?: boolean; filament?: boolean } | undefined) : undefined;
			if (err instanceof ApiError && err.status === 409 && d?.filament) {
				const ok = await confirmAction({ title: 'Not enough filament?', body: err.message, confirmLabel: 'Print anyway', danger: true });
				if (!ok) return null;
				req.confirmFilament = true;
				continue;
			}
			if (err instanceof ApiError && err.status === 409 && d?.exists) {
				const ok = await confirmAction({
					title: `Replace ${d.target}?`,
					body: `${opts.printerName} already has a file with this name. Sending replaces it.`,
					detail: d.target,
					confirmLabel: 'Replace',
					danger: true
				});
				if (!ok) return null;
				req.overwrite = true;
				continue;
			}
			if (err instanceof ApiError && err.status === 409 && d?.confirmRequired) {
				const ok = await confirmAction({ title: 'Send without printing?', body: err.message, confirmLabel: 'Just send it' });
				if (!ok) return null;
				req.confirm = true;
				continue;
			}
			toast('error', 'Could not send the file', errorMessage(err));
			return null;
		}
	}
	return null;
}

export const getSend = (id: string) => api.get<LibrarySend>(`/api/library/sends/${encodeURIComponent(id)}`);
export const listSends = () => api.get<LibrarySend[]>('/api/library/sends');
export const cancelSend = (id: string) => api.del(`/api/library/sends/${encodeURIComponent(id)}`);

/** Polls a transfer until it ends, calling `onupdate` with each state. */
export async function followSend(id: string, onupdate: (s: LibrarySend) => void, everyMs = 400): Promise<LibrarySend> {
	for (;;) {
		const s = await getSend(id);
		onupdate(s);
		if (s.state !== 'sending' && s.state !== 'processing') return s;
		await new Promise((r) => setTimeout(r, everyMs));
	}
}

/** Copies a file from OctoPrint to a writable library source; asks before replacing. */
export async function saveToLibrary(printerId: string, opts: { path: string; sourceId: string; sourceName: string; folder: string }): Promise<boolean> {
	const url = `/api/printers/${encodeURIComponent(printerId)}/files/library`;
	const req: Record<string, unknown> = { path: opts.path, sourceId: opts.sourceId, folder: opts.folder };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const r = await api.post<{ path: string }>(url, req);
			toast('success', `Saved to ${opts.sourceName}`, r.path);
			return true;
		} catch (err) {
			const d = err instanceof ApiError ? (err.detail as { exists?: boolean; target?: string } | undefined) : undefined;
			if (err instanceof ApiError && err.status === 409 && d?.exists) {
				const ok = await confirmAction({ title: `Replace ${d.target}?`, body: `${opts.sourceName} already has a file with this name.`, detail: d.target, confirmLabel: 'Replace', danger: true });
				if (!ok) return false;
				req.overwrite = true;
				continue;
			}
			toast('error', 'Could not save to the library', errorMessage(err));
			return false;
		}
	}
	return false;
}
