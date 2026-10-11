import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, refreshSoon } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { prep, prepChoice, prepConfirmRequired } from '#lib/server/preprint/service.ts';
import { FILAMENT_ASK } from '#lib/spools.ts';
import { filamentWarning, perToolMm, wantsFilamentCheck } from '#lib/server/spools/check.ts';
import type { RequestHandler } from './$types';

const COMMANDS = ['start', 'pause', 'resume', 'cancel', 'restart'] as const;
type Command = (typeof COMMANDS)[number];

/**
 * Job control: `{ command: start | pause | resume | cancel | restart }`. Cancelling
 * needs `confirm: true`; so does starting or restarting when an active Spoolman spool
 * holds less filament than the file needs (409 `confirmRequired`, then resend). Starting
 * (and Klipper's restart, which prints the last file again) runs the pre-print steps
 * first when they're set up, after the same plan confirmation as Files
 * (`preprint: 'run' | 'skip'`). Restarting a paused OctoPrint job skips them: its part
 * is still on the bed.
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, backend } = controlTarget(locals.user, params.id);
	const b = await body(request);
	const command = b.command as Command;
	if (!COMMANDS.includes(command)) throw new BadRequest(`"command" must be one of ${COMMANDS.join(', ')}`);
	if (command === 'cancel' && b.confirm !== true) return confirmRequired('Cancelling ends the print and can’t be undone. Send confirm: true to cancel.');
	const starting = command === 'start' || command === 'restart';
	const job = starting ? ((await backend.status().catch(() => null))?.job ?? null) : null;
	if (starting && b.confirm !== true && wantsFilamentCheck(printer.id)) {
		let perTool = perToolMm(job?.filament);
		// Klipper's status has no analysis: ask for the file's slicer metadata.
		if (!Object.keys(perTool).length && job?.file) perTool = (await backend.fileDetails(job.file.origin === 'sdcard' ? 'sdcard' : 'local', job.file.path))?.perTool ?? {};
		const warning = Object.keys(perTool).length ? await filamentWarning(printer.id, { perTool }) : null;
		if (warning) return confirmRequired(warning, FILAMENT_ASK);
	}
	const file = job?.file ?? printers.snapshot(printer.id)?.job?.file ?? null;
	if (starting && file) {
		const origin = file.origin === 'sdcard' ? 'sdcard' : 'local';
		const choice = prepChoice(b.preprint);
		const paused = command === 'restart' && printer.kind === 'octoprint';
		const plan = choice === 'skip' || paused ? undefined : await prep.plan(printer, backend, origin, file.path);
		if (!choice && plan?.configured) return prepConfirmRequired(plan, file.display || file.name);
		const r = await prep.begin({ printer, backend, origin, path: file.path, how: command, locals, via: 'job' }, { plan, skip: choice === 'skip' });
		return json({ ok: true, preparing: r.preparing });
	}
	const snap = printers.snapshot(printer.id);
	const display = snap?.job?.file?.display ?? null;
	await backend.jobCommand(command);
	audit(locals, `job.${command}`, { printer, detail: display ?? undefined });
	refreshSoon(printer.id);
	return json({ ok: true });
});
