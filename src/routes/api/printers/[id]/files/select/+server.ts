import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, refreshSoon } from '#lib/server/control.ts';
import { FILAMENT_ASK } from '#lib/spools.ts';
import { filamentWarning, needForFile, wantsFilamentCheck } from '#lib/server/spools/check.ts';
import { audit } from '#lib/server/permissions.ts';
import { ensurePrinterOn } from '#lib/server/power/service.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { prep, prepChoice, prepConfirmRequired } from '#lib/server/preprint/service.ts';
import { isConnected } from '#lib/printer.ts';
import type { RequestHandler } from './$types';

/**
 * Selects a file, and prints it with `print: true`: `{ origin, path, print, confirm?, preprint? }`.
 * Answers 409 `confirmRequired` when an active Spoolman spool won't last the print, and
 * (with leveling or pre-print G-code set up for the printer) with the plan of what runs
 * first, until `preprint: 'run' | 'skip'` is sent. `preparing: true` in the answer:
 * the steps run now and the file starts after them.
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const { printer, backend } = controlTarget(locals.user, params.id);
	const b = await body(request);
	const origin = b.origin === 'sdcard' ? 'sdcard' : 'local';
	const path = typeof b.path === 'string' ? b.path.replace(/^\/+/, '') : '';
	if (!path || path.split('/').includes('..')) throw new BadRequest('"path" is required');
	const print = b.print === true;
	if (!print) {
		await backend.selectFile(origin, path, false);
		audit(locals, 'file.select', { printer, detail: `${origin === 'sdcard' ? 'SD: ' : ''}${path}` });
		refreshSoon(printer.id);
		return json({ ok: true });
	}
	if (b.confirm !== true && wantsFilamentCheck(printer.id)) {
		const warning = await filamentWarning(printer.id, await needForFile(backend, origin, path));
		if (warning) return confirmRequired(warning, FILAMENT_ASK);
	}
	const choice = prepChoice(b.preprint);
	const plan = choice === 'skip' ? undefined : await prep.plan(printer, backend, origin, path);
	if (!choice && plan?.configured) return prepConfirmRequired(plan, path.split('/').pop() ?? path);
	// Smart plug with auto power-on: switch the printer on (and connect it) first.
	if (!isConnected(printers.snapshot(printer.id)?.state ?? 'unknown')) await ensurePrinterOn(printer.id, { locals, reason: `to print ${path}` });
	const r = await prep.begin({ printer, backend, origin, path, how: 'select', locals, via: 'files' }, { plan, skip: choice === 'skip' });
	return json({ ok: true, preparing: r.preparing });
});
