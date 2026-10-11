/**
 * Files on a printer's OctoPrint: listing, streaming uploads with progress, select /
 * print, delete and folders. Uploads use XMLHttpRequest because fetch can't report
 * upload progress.
 */
import { api, ApiError, errorMessage } from './api.ts';
import { confirmAction, toast } from './state.svelte.ts';
import { act } from './actions.ts';
import type { FileEntry, FileListing } from '#lib/types.ts';

const base = (id: string) => `/api/printers/${encodeURIComponent(id)}/files`;

export const listFiles = (printerId: string) => api.get<FileListing>(base(printerId));

export const thumbnailUrl = (printerId: string, src: string) => `${base(printerId)}/thumbnail?src=${encodeURIComponent(src)}`;

export const GCODE_ACCEPT = '.gcode,.gco,.g,.gc,.bgcode';

export function isGcodeName(name: string): boolean {
	return /\.(gcode|gco|g|gc|bgcode)$/i.test(name);
}

export interface Upload {
	id: number;
	name: string;
	size: number;
	loaded: number;
	state: 'uploading' | 'processing' | 'done' | 'error' | 'aborted';
	error?: string;
	abort: () => void;
}

let nextUpload = 1;

/** Uploads one file; `onprogress` sees the same object as it changes. */
export function uploadFile(
	printerId: string,
	file: File,
	opts: { path: string; origin?: 'local' | 'sdcard'; print?: boolean },
	onprogress: (u: Upload) => void
): Promise<{ printing: boolean; preparing: boolean; path: string | null }> {
	const xhr = new XMLHttpRequest();
	const u: Upload = { id: nextUpload++, name: file.name, size: file.size, loaded: 0, state: 'uploading', abort: () => xhr.abort() };
	const q = new URLSearchParams({ origin: opts.origin ?? 'local', name: file.name });
	if (opts.path) q.set('path', opts.path);
	if (opts.print) q.set('print', '1');
	return new Promise((resolve, reject) => {
		xhr.open('POST', `${base(printerId)}/upload?${q}`);
		xhr.upload.onprogress = (e) => {
			u.loaded = e.loaded;
			// Everything sent: OctoPrint is storing (and maybe analysing) it now.
			if (e.lengthComputable && e.loaded >= e.total) u.state = 'processing';
			onprogress(u);
		};
		xhr.onload = () => {
			let data: { message?: string; hint?: string; printing?: boolean; preparing?: boolean; path?: string | null } = {};
			try {
				data = JSON.parse(xhr.responseText);
			} catch {}
			if (xhr.status >= 200 && xhr.status < 300) {
				u.state = 'done';
				u.loaded = u.size;
				onprogress(u);
				resolve({ printing: !!data.printing, preparing: !!data.preparing, path: data.path ?? null });
			} else {
				u.state = 'error';
				u.error = data.message ? `${data.message}${data.hint ? `. ${data.hint}` : ''}` : `HTTP ${xhr.status}`;
				onprogress(u);
				reject(new ApiError(u.error, xhr.status));
			}
		};
		xhr.onerror = () => {
			u.state = 'error';
			u.error = 'Network error during upload';
			onprogress(u);
			reject(new Error(u.error));
		};
		xhr.onabort = () => {
			u.state = 'aborted';
			onprogress(u);
			reject(new Error('Upload cancelled'));
		};
		const form = new FormData();
		form.set('file', file, file.name);
		xhr.send(form);
		onprogress(u);
	});
}

export async function printFile(printerId: string, f: FileEntry, print: boolean): Promise<boolean> {
	// Printing may ask first (409): e.g. when the active spool won't last.
	if (print) return act(`${base(printerId)}/select`, { origin: f.origin, path: f.path, print }, { done: 'Print started', failed: 'Could not start the print' });
	try {
		await api.post(`${base(printerId)}/select`, { origin: f.origin, path: f.path, print });
		toast('success', 'File selected', f.display);
		return true;
	} catch (err) {
		toast('error', print ? 'Could not start the print' : 'Could not select the file', errorMessage(err));
		return false;
	}
}

export async function deleteFile(printerId: string, f: FileEntry): Promise<boolean> {
	const folder = f.type === 'folder';
	const ok = await confirmAction({
		title: `Delete ${f.display}?`,
		body: folder ? 'The folder and everything in it are deleted from OctoPrint. This can’t be undone.' : 'The file is deleted from OctoPrint. This can’t be undone.',
		detail: `${f.origin === 'sdcard' ? 'SD card' : 'local'}: ${f.path}`,
		confirmLabel: 'Delete',
		danger: true
	});
	if (!ok) return false;
	try {
		await api.del(`${base(printerId)}?${new URLSearchParams({ origin: f.origin, path: f.path, confirm: '1' })}`);
		toast('success', 'Deleted', f.display);
		return true;
	} catch (err) {
		toast('error', 'Could not delete', errorMessage(err));
		return false;
	}
}

export async function createFolder(printerId: string, name: string, parent: string): Promise<boolean> {
	try {
		await api.post(`${base(printerId)}/folder`, { name, parent });
		return true;
	} catch (err) {
		toast('error', 'Could not create the folder', errorMessage(err));
		return false;
	}
}
