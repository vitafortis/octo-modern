import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, refreshSoon } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { parseJobResponse } from '#lib/server/octoprint/parse.ts';
import { FILAMENT_ASK } from '#lib/spools.ts';
import { filamentWarning, perToolMm, wantsFilamentCheck } from '#lib/server/spools/check.ts';
import type { RequestHandler } from './$types';

const COMMANDS = ['start', 'pause', 'resume', 'cancel', 'restart'] as const;
type Command = (typeof COMMANDS)[number];

/**
 * Job control: `{ command: start | pause | resume | cancel | restart }`. Cancelling
 * needs `confirm: true`; so does starting or restarting when an active Spoolman spool
 * holds less filament than the file needs (409 `confirmRequired`, then resend).
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, client } = controlTarget(locals.user, params.id);
	const b = await body(request);
	const command = b.command as Command;
	if (!COMMANDS.includes(command)) throw new BadRequest(`"command" must be one of ${COMMANDS.join(', ')}`);
	if (command === 'cancel' && b.confirm !== true) return confirmRequired('Cancelling ends the print and can’t be undone. Send confirm: true to cancel.');
	if ((command === 'start' || command === 'restart') && b.confirm !== true && wantsFilamentCheck(printer.id)) {
		const job = parseJobResponse(await client.job().catch(() => null)).job;
		const perTool = perToolMm(job?.filament);
		const warning = Object.keys(perTool).length ? await filamentWarning(printer.id, { perTool }) : null;
		if (warning) return confirmRequired(warning, FILAMENT_ASK);
	}
	const snap = printers.snapshot(printer.id);
	const file = snap?.job?.file?.display ?? null;
	if (command === 'pause') await client.jobCommand('pause', 'pause');
	else if (command === 'resume') await client.jobCommand('pause', 'resume');
	else await client.jobCommand(command);
	audit(locals, `job.${command}`, { printer, detail: file ?? undefined });
	refreshSoon(printer.id);
	return json({ ok: true });
});
