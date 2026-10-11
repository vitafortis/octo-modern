/**
 * The print queue in the browser: one shared, polled copy of /api/queue (the queue page,
 * the printer page's Queue tab and the overview's "bed is clear" prompts all read it),
 * and the actions that change it.
 */
import { api, ApiError, errorMessage } from './api.ts';
import { confirmAction, toast } from './state.svelte.ts';
import type { QueueJob, QueuePrinter, QueueState } from '#lib/queue.ts';

export const queue = $state<QueueState & { loaded: boolean }>({ paused: false, jobs: [], printers: [], loaded: false });

export async function refreshQueue() {
	try {
		const s = await api.get<QueueState>('/api/queue');
		queue.paused = s.paused;
		queue.jobs = s.jobs;
		queue.printers = s.printers;
		queue.loaded = true;
	} catch {
		// Offline or signed out; the next tick tries again.
	}
}

let timer: ReturnType<typeof setInterval> | undefined;
let users = 0;

/** Polls the queue while something shows it (reference-counted); returns the stop function. */
export function pollQueue(everyMs = 4_000): () => void {
	users++;
	if (!timer) {
		void refreshQueue();
		timer = setInterval(() => {
			if (document.visibilityState === 'visible') void refreshQueue();
		}, everyMs);
	}
	return () => {
		users--;
		if (users <= 0 && timer) {
			clearInterval(timer);
			timer = undefined;
			users = 0;
		}
	};
}

export const queuePrinter = (id: string): QueuePrinter | undefined => queue.printers.find((p) => p.printerId === id);

/** Whether to ask for the bed to be cleared on a printer card or page: someone is waiting for it. */
export const needsBedClear = (p: QueuePrinter | undefined) => !!p && p.awaitingClear && p.waiting > 0;

async function done<T>(p: Promise<T>, failed: string, ok?: string): Promise<T | null> {
	try {
		const r = await p;
		if (ok) toast('success', ok);
		void refreshQueue();
		return r;
	} catch (err) {
		toast('error', failed, errorMessage(err));
		return null;
	}
}

export function bedClear(printerId: string, name?: string) {
	return done(api.post(`/api/printers/${encodeURIComponent(printerId)}/queue`, { action: 'bed-clear' }), 'Could not confirm the bed', `Bed confirmed clear${name ? ` on ${name}` : ''}`);
}

export function holdPrinter(printerId: string, hold: boolean) {
	return done(api.post(`/api/printers/${encodeURIComponent(printerId)}/queue`, { action: hold ? 'hold' : 'release' }), hold ? 'Could not pause the printer' : 'Could not resume the printer', hold ? 'Queue paused for this printer' : 'Queue resumed for this printer');
}

export function setPrinterTags(printerId: string, tags: string[]) {
	return done(api.post(`/api/printers/${encodeURIComponent(printerId)}/queue`, { action: 'tags', tags }), 'Could not save the tags', 'Tags saved');
}

export function setQueuePaused(paused: boolean) {
	return done(api.post('/api/queue/pause', { paused }), 'Could not change the queue', paused ? 'Queue paused' : 'Queue resumed');
}

export interface JobTarget {
	printerId: string | null;
	tags: string[];
	copies: number;
}

export function addLibraryJob(sourceId: string, path: string, t: JobTarget) {
	return done(api.post<QueueJob>('/api/queue', { source: 'library', sourceId, path, ...t }), 'Could not add to the queue', 'Added to the queue');
}

export function addPrinterFileJob(printerId: string, path: string, copies = 1) {
	return done(api.post<QueueJob>('/api/queue', { source: 'printer', printerId, path, copies }), 'Could not add to the queue', 'Added to the queue');
}

/** Uploads a file into the queue, reporting progress (0–1). */
export function uploadJob(file: File, t: JobTarget, onprogress?: (f: number) => void): Promise<QueueJob | null> {
	const q = new URLSearchParams({ copies: String(t.copies) });
	if (t.printerId) q.set('printerId', t.printerId);
	else if (t.tags.length) q.set('tags', t.tags.join(','));
	const form = new FormData();
	form.set('file', file, file.name);
	return new Promise((resolve) => {
		const xhr = new XMLHttpRequest();
		xhr.open('POST', `/api/queue/upload?${q}`);
		xhr.upload.onprogress = (e) => e.lengthComputable && onprogress?.(e.loaded / e.total);
		xhr.onload = () => {
			let data: { message?: string } & Partial<QueueJob> = {};
			try {
				data = JSON.parse(xhr.responseText);
			} catch {}
			if (xhr.status >= 200 && xhr.status < 300) {
				toast('success', 'Added to the queue', file.name);
				void refreshQueue();
				resolve(data as QueueJob);
			} else {
				toast('error', 'Upload failed', data.message ?? xhr.statusText);
				resolve(null);
			}
		};
		xhr.onerror = () => {
			toast('error', 'Upload failed', 'The connection dropped');
			resolve(null);
		};
		xhr.send(form);
	});
}

export function patchJob(id: string, patch: Record<string, unknown>, failed = 'Could not change the job') {
	return done(api.patch<QueueJob>(`/api/queue/${encodeURIComponent(id)}`, patch), failed);
}

export function reorderJobs(ids: string[]) {
	return done(api.post<QueueState>('/api/queue/order', { ids }), 'Could not reorder the queue');
}

export async function removeJob(job: QueueJob) {
	const url = `/api/queue/${encodeURIComponent(job.id)}`;
	// Running jobs: the server asks for confirmation (409), act() handles it.
	const running = job.status === 'printing' || job.status === 'starting';
	if (running) {
		const ok = await actDelete(url);
		if (ok) void refreshQueue();
		return ok;
	}
	return (await done(api.del(url), 'Could not remove the job', 'Removed from the queue')) !== null;
}

/** DELETE with the confirm-and-retry flow (act() only POSTs). */
async function actDelete(url: string): Promise<boolean> {
	try {
		await api.del(url);
		return true;
	} catch (err) {
		if (err instanceof ApiError && err.status === 409 && err.detail?.confirmRequired) {
			if (!(await confirmAction({ title: 'Remove a running job?', body: err.message, confirmLabel: 'Remove', danger: true }))) return false;
			try {
				await api.del(`${url}?confirm=1`);
				toast('success', 'Removed from the queue');
				return true;
			} catch (err2) {
				toast('error', 'Could not remove the job', errorMessage(err2));
				return false;
			}
		}
		toast('error', 'Could not remove the job', errorMessage(err));
		return false;
	}
}
