import { json } from '@sveltejs/kit';
import { body, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, currentState, refreshSoon, viewTarget } from '#lib/server/control.ts';
import { auditControl, isMovement, parseControlAction, performControl } from '#lib/server/control-actions.ts';
import { currentProfile } from '#lib/control/profile.ts';
import { parseCustomControls } from '#lib/control/custom.ts';
import { movementBlocked } from '#lib/control/jog.ts';
import { dangerReason } from '#lib/terminal/gcodes.ts';
import { toOctoPrintError } from '#lib/server/octoprint/errors.ts';
import { jobActive } from '#lib/printer.ts';
import type { RequestHandler } from './$types';

/**
 * What the Control tab needs: the printer profile in use (build volume, heaters,
 * extruders, axis inversion) and OctoPrint's custom controls.
 */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const { client } = viewTarget(locals.user, params.id);
	const [profiles, custom] = await Promise.allSettled([client.get<unknown>('/api/printerprofiles'), client.get<unknown>('/api/printer/command/custom')]);
	if (profiles.status === 'rejected') throw profiles.reason;
	return json(
		{
			profile: currentProfile(profiles.value),
			controls: custom.status === 'fulfilled' ? parseCustomControls(custom.value) : [],
			controlsError: custom.status === 'rejected' ? toOctoPrintError(custom.reason).message : null
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
});

/**
 * Jog, home, extrude/retract, tool select, motors off, fan, feed and flow rate, and
 * custom controls: `{ action: 'jog', x: 10 }`, `{ action: 'home', axes: ['x','y'] }`, …
 * Anything that moves the machine is refused (409) while a print runs; custom G-code
 * needs `confirm: true` while printing and for dangerous commands, like the terminal.
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, client } = controlTarget(locals.user, params.id);
	const b = await body(request);
	const action = parseControlAction(b);
	const state = await currentState(printer.id, client);
	if (isMovement(action)) {
		const why = movementBlocked(state);
		if (why) return json({ message: why, blocked: true }, { status: 409 });
	}
	if (action.action === 'custom' && b.confirm !== true) {
		const danger = action.commands?.map(dangerReason).find(Boolean);
		if (danger) return confirmRequired(`${danger} Send confirm: true to send it.`);
		if (jobActive(state)) return confirmRequired('A print is running; commands sent now are mixed into it. Send confirm: true to send anyway.');
	}
	await performControl(client, action);
	auditControl(locals, printer, action);
	refreshSoon(printer.id);
	return json({ ok: true });
});
