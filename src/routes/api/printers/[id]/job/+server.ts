import { body, handler } from '#lib/server/http.ts';
import { controlTarget } from '#lib/server/control.ts';
import { jobCommand, outcomeResponse, type JobCommandName } from '#lib/server/printer-actions.ts';
import type { RequestHandler } from './$types';

/**
 * Job control: `{ command: start | pause | resume | cancel | restart }`. Cancelling
 * needs `confirm: true`; so does starting or restarting when an active Spoolman spool
 * holds less filament than the file needs (409 `confirmRequired`, then resend). Starting
 * (and Klipper's restart, which prints the last file again) runs the pre-print steps
 * first when they're set up, after the same plan confirmation as Files
 * (`preprint: 'run' | 'skip'`). Restarting a paused OctoPrint job skips them: its part
 * is still on the bed. The rules live in printer-actions.ts (shared with MCP).
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const target = controlTarget(locals.user, params.id);
	const b = await body(request);
	return outcomeResponse(await jobCommand(target, locals, b.command as JobCommandName, { confirm: b.confirm === true, preprint: b.preprint }));
});
