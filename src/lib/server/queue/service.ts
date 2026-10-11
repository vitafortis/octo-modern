/**
 * The queue as routes use it: who sees and changes which job, adding jobs from the
 * library, a printer's files or an upload, and the browser's view of it all.
 */
import { rename, rm } from 'node:fs/promises';
import { BadRequest, Forbidden, NotFound } from '../http.ts';
import { audit, canControl, canSee, requireControl, visiblePrinters } from '../permissions.ts';
import { roleAllows } from '../access.ts';
import { clientFor, printers } from '../octoprint/manager.ts';
import { getPrinter } from '../store.ts';
import { getSource } from '../library/sources.ts';
import { relPath, requireSource, sourceAllowsPrinter, withDriver } from '../library/service.ts';
import { LibraryError } from '../library/drivers.ts';
import { dispatcher } from './dispatcher.ts';
import { ensureStagingDir, octoprintFileSize, removeStaged, stagedPath } from './files.ts';
import { deleteJob, getJob, insertJob, isPaused, listJobs, type StoredJob } from './store.ts';
import { clampCopies, parseTags, type QueueJob, type QueueState } from '#lib/queue.ts';
import { baseName, isPrintable } from '#lib/library.ts';
import { jobActive } from '#lib/printer.ts';
import { currentState } from '../control.ts';
import type { User } from '#lib/types.ts';
import { randomUUID } from 'node:crypto';

/** Viewers see jobs for printers they can see, and "any printer" jobs. */
export function canSeeJob(user: User | null, job: Pick<QueueJob, 'printerId'>): boolean {
	if (!user) return false;
	if (!job.printerId) return true;
	const p = getPrinter(job.printerId);
	return !p ? user.role === 'admin' : canSee(user, p);
}

/** Operators and admins change jobs for printers they control, and "any printer" jobs. */
export function canManageJob(user: User | null, job: Pick<QueueJob, 'printerId'>): boolean {
	if (!user || !roleAllows(user.role, 'control')) return false;
	if (!job.printerId) return true;
	const p = getPrinter(job.printerId);
	return !p ? user.role === 'admin' : canControl(user, p);
}

export function requireJob(user: User | null, id: string, manage = false): StoredJob {
	const job = getJob(id);
	if (!job || !canSeeJob(user, job)) throw new NotFound('Queue job not found');
	if (manage && !canManageJob(user, job)) throw new Forbidden('Your role can’t change this job');
	return job;
}

/** What the browser gets: jobs and printers the user can see. */
export function queueState(user: User | null): QueueState {
	const all = listJobs();
	const visible = new Set(visiblePrinters(user).map((p) => p.id));
	const names = new Map<string, string>();
	const jobs = all
		.filter((j) => canSeeJob(user, j))
		.map(({ position: _p, activePath: _a, createdById: _c, ...j }) => {
			if (j.source === 'library' && j.sourceId) {
				if (!names.has(j.sourceId)) names.set(j.sourceId, getSource(j.sourceId)?.name ?? 'Removed source');
				j.sourceName = names.get(j.sourceId)!;
			}
			return j;
		});
	return { paused: isPaused(), jobs, printers: dispatcher.printerStates(all).filter((p) => visible.has(p.printerId)) };
}

interface Target {
	printerId: string | null;
	tags: string[];
	copies: number;
}

/** Validates the target of a new or edited job for this user. */
export function parseTarget(user: User | null, b: Record<string, unknown>): Target {
	if (!user || !roleAllows(user.role, 'control')) throw new Forbidden('Your role can only watch the queue');
	const printerId = typeof b.printerId === 'string' && b.printerId ? b.printerId : null;
	if (printerId) requireControl(user, printerId);
	return { printerId, tags: printerId ? [] : parseTags(b.tags), copies: clampCopies(b.copies ?? 1) };
}

const label = (user: User | null) => user?.name || user?.email || null;

export async function addLibraryJob(user: User | null, b: Record<string, unknown>): Promise<StoredJob> {
	const t = parseTarget(user, b);
	if (typeof b.sourceId !== 'string') throw new BadRequest('"sourceId" is required');
	const src = requireSource(user, b.sourceId);
	const path = relPath(b.path);
	if (!path || !isPrintable(path)) throw new BadRequest('Pick a G-code file');
	if (t.printerId && !sourceAllowsPrinter(src, t.printerId)) throw new Forbidden(`${src.name} isn’t available to that printer`);
	const st = await withDriver(src, (d) => d.stat(path));
	if (st.type !== 'file') throw new LibraryError('Not a file', { status: 400, code: 'NOT_A_FILE' });
	const job = insertJob({ name: baseName(path), source: 'library', sourceId: src.id, path, size: st.size, ...t, createdById: user!.id, createdBy: label(user) });
	dispatcher.kick();
	return job;
}

export async function addPrinterFileJob(user: User | null, b: Record<string, unknown>): Promise<StoredJob> {
	if (typeof b.printerId !== 'string' || !b.printerId) throw new BadRequest('"printerId" is required');
	const t = parseTarget(user, b);
	const printer = requireControl(user, b.printerId);
	const path = relPath(b.path);
	if (!path) throw new BadRequest('"path" is required');
	const size = await octoprintFileSize(clientFor(printer), path);
	if (size == null) throw new NotFound(`${printer.name} has no file ${path}`);
	// A printer's own file can only print there.
	const job = insertJob({ name: baseName(path), source: 'printer', sourceId: printer.id, path, size: size >= 0 ? size : null, printerId: printer.id, tags: [], copies: t.copies, createdById: user!.id, createdBy: label(user) });
	dispatcher.kick();
	return job;
}

/** A sanitized file name for an upload. */
export function uploadName(raw: string | null | undefined): string {
	const name = baseName(String(raw ?? '').replace(/\\/g, '/'))
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f"]/g, '_')
		.trim()
		.slice(0, 200);
	return name && name !== '.' && name !== '..' ? name : 'upload.gcode';
}

/** Turns an uploaded temporary file into a queued job (the file moves into the queue's folder). */
export async function addUploadJob(opts: { tmpFile: string; filename: string; size: number; printerId: string | null; tags: string[]; copies: number; createdById: string | null; createdBy: string | null }): Promise<StoredJob> {
	const name = uploadName(opts.filename);
	if (!isPrintable(name)) {
		await rm(opts.tmpFile, { force: true });
		throw new BadRequest('Only G-code files can be queued (.gcode, .gco, .g, .bgcode)');
	}
	await ensureStagingDir();
	const id = randomUUID();
	await rename(opts.tmpFile, stagedPath(id));
	const job = insertJob({ id, name, source: 'upload', sourceId: null, path: '', size: opts.size, printerId: opts.printerId, tags: opts.tags, copies: opts.copies, createdById: opts.createdById, createdBy: opts.createdBy });
	dispatcher.kick();
	return job;
}

export async function removeJob(job: StoredJob): Promise<void> {
	deleteJob(job.id);
	if (job.source === 'upload') await removeStaged(job.id);
}

/**
 * Someone says the bed is clear. Refused (409) while the printer prints: the print
 * still on the bed would end up under the next one.
 */
export async function confirmBedClear(locals: { user: User | null; ip?: string }, printerId: string, via?: string): Promise<{ ok: true } | { ok: false; message: string }> {
	const printer = getPrinter(printerId);
	if (!printer) return { ok: false, message: 'Printer not found' };
	// Ask OctoPrint (the live snapshot can trail by a poll), and count a queued job still running.
	let state = printers.snapshot(printerId)?.state;
	if (printer.hasApiKey) state = await currentState(printerId, clientFor(printer)).catch(() => state);
	const running = listJobs().some((j) => j.activePrinterId === printerId && (j.status === 'printing' || j.status === 'starting'));
	if ((state && jobActive(state)) || running) return { ok: false, message: `${printer.name} is printing; confirm the bed once the print is done and removed` };
	dispatcher.bedCleared(printerId);
	audit(locals, 'queue.bed_clear', { printer, detail: via ?? undefined });
	return { ok: true };
}
