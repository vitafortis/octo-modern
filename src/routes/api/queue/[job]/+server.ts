import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { confirmRequired } from '#lib/server/control.ts';
import { getPrinter } from '#lib/server/store.ts';
import { getSource } from '#lib/server/library/sources.ts';
import { sourceAllowsPrinter } from '#lib/server/library/service.ts';
import { dispatcher } from '#lib/server/queue/dispatcher.ts';
import { move, moveToEnd, transition, updateJob, type JobPatch } from '#lib/server/queue/store.ts';
import { parseTarget, removeJob, requireJob } from '#lib/server/queue/service.ts';
import { clampCopies } from '#lib/queue.ts';
import type { RequestHandler } from './$types';

/**
 * Changes a job: `{ copies?, printerId?, tags?, move?: -1|1, requeue?: true }`.
 * `requeue` puts a failed (or finished) job back at the end of the queue.
 */
export const PATCH: RequestHandler = handler(async ({ locals, params, request }) => {
	const job = requireJob(locals.user, params.job, true);
	const b = await body(request);
	const what: string[] = [];
	if (b.move === -1 || b.move === 1) {
		move(job.id, b.move);
		what.push(b.move === -1 ? 'moved up' : 'moved down');
	}
	if (b.requeue === true) {
		if (job.status !== 'failed' && job.status !== 'done') throw new BadRequest('Only failed or finished jobs can be requeued');
		transition(job.id, ['failed', 'done'], { status: 'queued', error: null, finishedAt: null, done: job.status === 'done' ? 0 : job.done });
		moveToEnd(job.id);
		what.push('requeued');
	}
	const patch: JobPatch = {};
	if (b.copies !== undefined) {
		patch.copies = Math.max(clampCopies(b.copies), job.done + (job.status === 'printing' || job.status === 'starting' ? 1 : 0));
		what.push(`copies ${patch.copies}`);
	}
	if (b.printerId !== undefined || b.tags !== undefined) {
		if (job.status === 'printing' || job.status === 'starting') throw new BadRequest('The job is running; change its printer after this copy');
		const t = parseTarget(locals.user, { printerId: b.printerId !== undefined ? b.printerId : job.printerId, tags: b.tags !== undefined ? b.tags : job.tags });
		if (job.source === 'printer' && t.printerId !== job.sourceId) throw new BadRequest('A printer’s own file can only print on that printer');
		if (job.source === 'library' && t.printerId) {
			const src = job.sourceId ? getSource(job.sourceId) : undefined;
			if (src && !sourceAllowsPrinter(src, t.printerId)) throw new BadRequest(`${src.name} isn’t available to that printer`);
		}
		patch.printerId = t.printerId;
		patch.tags = t.tags;
		what.push(t.printerId ? `→ ${getPrinter(t.printerId)?.name}` : `→ any printer${t.tags.length ? ` with ${t.tags.join(', ')}` : ''}`);
	}
	const updated = updateJob(job.id, patch);
	if (what.length) audit(locals, 'queue.edit', { printer: job.printerId ? getPrinter(job.printerId) : undefined, detail: `${job.name}: ${what.join(', ')}` });
	dispatcher.kick();
	return json(updated);
});

/** Removes a job. A running one asks first (removing it doesn't stop the print). */
export const DELETE: RequestHandler = handler(async ({ locals, params, request, url }) => {
	const job = requireJob(locals.user, params.job, true);
	const b = await request.json().catch(() => ({}));
	const confirmed = url.searchParams.get('confirm') === '1' || (b && typeof b === 'object' && (b as Record<string, unknown>).confirm === true);
	if ((job.status === 'printing' || job.status === 'starting') && !confirmed) {
		const p = job.activePrinterId ? getPrinter(job.activePrinterId) : undefined;
		return confirmRequired(`${job.name} is ${job.status} on ${p?.name ?? 'a printer'}. Removing it from the queue doesn’t stop the print.`);
	}
	await removeJob(job);
	audit(locals, 'queue.remove', { printer: job.printerId ? getPrinter(job.printerId) : undefined, detail: job.name });
	return json({ ok: true });
});
