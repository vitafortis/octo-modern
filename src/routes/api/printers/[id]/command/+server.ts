import { json } from '@sveltejs/kit';
import { body, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, currentState, isEmergencyStop, parseCommands, refreshSoon } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { jobActive } from '#lib/printer.ts';
import { dangerReason } from '#lib/terminal/gcodes.ts';
import type { RequestHandler } from './$types';

/**
 * Sends G-code: `{ commands: ["G28", "M105"] }` or a newline-separated string.
 * Needs `confirm: true` while a print is running, for M112 (emergency stop) and for the
 * other commands flagged dangerous in #lib/terminal/gcodes.ts (M999, M500, M502, M997, …).
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, client } = controlTarget(locals.user, params.id);
	const b = await body(request);
	const commands = parseCommands(b.commands);
	const estop = commands.some(isEmergencyStop);
	const state = await currentState(printer.id, client);
	if (b.confirm !== true) {
		if (estop) return confirmRequired('M112 is an emergency stop: the printer halts immediately and needs a reset. Send confirm: true to send it.');
		const danger = commands.map(dangerReason).find(Boolean);
		if (danger) return confirmRequired(`${danger} Send confirm: true to send it.`);
		if (jobActive(state)) return confirmRequired('A print is running; G-code sent now is mixed into it. Send confirm: true to send anyway.');
	}
	await client.sendCommands(commands);
	audit(locals, estop ? 'printer.emergency_stop' : 'gcode.send', {
		printer,
		detail: `${commands.join(' · ').slice(0, 480)}${jobActive(state) ? ` (while ${state})` : ''}`
	});
	refreshSoon(printer.id);
	return json({ ok: true, sent: commands.length });
});
