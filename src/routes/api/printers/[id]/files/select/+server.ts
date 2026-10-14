import { json } from '@sveltejs/kit';
import { body, handler } from '#lib/server/http.ts';
import { controlTarget, refreshSoon } from '#lib/server/control.ts';
import { audit } from '#lib/server/permissions.ts';
import { outcomeResponse, printerPath, printFile } from '#lib/server/printer-actions.ts';
import type { RequestHandler } from './$types';

/**
 * Selects a file, and prints it with `print: true`: `{ origin, path, print, confirm?, preprint? }`.
 * Answers 409 `confirmRequired` when an active Spoolman spool won't last the print, and
 * (with leveling or pre-print G-code set up for the printer) with the plan of what runs
 * first, until `preprint: 'run' | 'skip'` is sent. `preparing: true` in the answer:
 * the steps run now and the file starts after them. (printer-actions.ts, shared with MCP.)
 */
export const POST: RequestHandler = handler(async ({ params, locals, request }) => {
	const target = controlTarget(locals.user, params.id);
	const { printer, backend } = target;
	const b = await body(request);
	const origin = b.origin === 'sdcard' ? 'sdcard' : 'local';
	const path = printerPath(b.path);
	if (b.print !== true) {
		await backend.selectFile(origin, path, false);
		audit(locals, 'file.select', { printer, detail: `${origin === 'sdcard' ? 'SD: ' : ''}${path}` });
		refreshSoon(printer.id);
		return json({ ok: true });
	}
	return outcomeResponse(await printFile(target, locals, { origin, path, confirm: b.confirm === true, preprint: b.preprint }));
});
