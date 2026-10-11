import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, refreshSoon } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { FILAMENT_ASK } from '#lib/spools.ts';
import { filamentWarning, perToolMm, wantsFilamentCheck } from '#lib/server/spools/check.ts';
import type { RequestHandler } from './$types';

const COMMANDS = ['start', 'pause', 'resume', 'cancel', 'restart'] as const;
type Command = (typeof COMMANDS)[number];

/**
 * Job control: `{ command: start | pause | resume | cancel | restart }`. Cancelling
 * needs `confirm: true`; so does starting when an active Spoolman spool holds less
 * filament than the file needs.
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, backend } = controlTarget(locals.user, params.id);
	const b = await body(request);
	const command = b.command as Command;
	if (!COMMANDS.includes(command)) throw new BadRequest(`"command" must be one of ${COMMANDS.join(', ')}`);
	if (command === 'cancel' && b.confirm !== true) return confirmRequired('Cancelling ends the print and can’t be undone. Send confirm: true to cancel.');
	if (command === 'start' && b.confirm !== true && wantsFilamentCheck(printer.id)) {
		const job = (await backend.status().catch(() => null))?.job ?? null;
		const perTool = perToolMm(job?.filament);
		const warning = Object.keys(perTool).length ? await filamentWarning(printer.id, { perTool }) : null;
		if (warning) return confirmRequired(warning, FILAMENT_ASK);
	}
	const snap = printers.snapshot(printer.id);
	const file = snap?.job?.file?.display ?? null;
	await backend.jobCommand(command);
	audit(locals, `job.${command}`, { printer, detail: file ?? undefined });
	refreshSoon(printer.id);
	return json({ ok: true });
});
