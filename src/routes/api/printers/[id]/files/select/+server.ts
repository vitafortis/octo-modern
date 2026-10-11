import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, refreshSoon } from '#lib/server/control.ts';
import { FILAMENT_ASK } from '#lib/spools.ts';
import { filamentWarning, needForFile, wantsFilamentCheck } from '#lib/server/spools/check.ts';
import { audit } from '#lib/server/permissions.ts';
import { ensurePrinterOn } from '#lib/server/power/service.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { isConnected } from '#lib/printer.ts';
import type { RequestHandler } from './$types';

/**
 * Selects a file, and prints it with `print: true`: `{ origin, path, print, confirm? }`.
 * Answers 409 `confirmRequired` when an active Spoolman spool won't last the print.
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, client } = controlTarget(locals.user, params.id);
	const b = await body(request);
	const origin = b.origin === 'sdcard' ? 'sdcard' : 'local';
	const path = typeof b.path === 'string' ? b.path.replace(/^\/+/, '') : '';
	if (!path || path.split('/').includes('..')) throw new BadRequest('"path" is required');
	const print = b.print === true;
	if (print && b.confirm !== true && wantsFilamentCheck(printer.id)) {
		const warning = await filamentWarning(printer.id, await needForFile(client, origin, path));
		if (warning) return confirmRequired(warning, FILAMENT_ASK);
	}
	// Smart plug with auto power-on: switch the printer on (and connect it) first.
	if (print && !isConnected(printers.snapshot(printer.id)?.state ?? 'unknown')) await ensurePrinterOn(printer.id, { locals, reason: `to print ${path}` });
	await client.selectFile(origin, path, print);
	audit(locals, print ? 'job.start' : 'file.select', { printer, detail: `${origin === 'sdcard' ? 'SD: ' : ''}${path}` });
	refreshSoon(printer.id);
	return json({ ok: true });
});
