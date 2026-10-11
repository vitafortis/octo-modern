import { json } from '@sveltejs/kit';
import { BadRequest, body, Forbidden, handler } from '#lib/server/http.ts';
import { audit, requirePrinter } from '#lib/server/permissions.ts';
import { loadGlobal, loadPrinter, savePrinter, SettingsError } from '#lib/server/preprint/settings.ts';
import { DEFAULT_LEVEL_COMMAND, MODE_LABEL } from '#lib/preprint.ts';
import type { RequestHandler } from './$types';

function admin(locals: App.Locals) {
	if (locals.user && locals.user.role !== 'admin') throw new Forbidden('Admins only');
}

/** One printer's pre-print settings, with the defaults they fall back to (admins). */
export const GET: RequestHandler = handler(({ params, locals }) => {
	admin(locals);
	const printer = requirePrinter(locals.user, params.id);
	return json({ settings: loadPrinter(printer.id), defaults: loadGlobal(), kindCommand: DEFAULT_LEVEL_COMMAND[printer.kind] });
});

/** `{ snippet?: { mode, gcode, match, skipPattern }, leveling?: { mode, command, skipPattern, heatBed, bedTemp } }`. */
export const PUT: RequestHandler = handler(async ({ params, locals, request }) => {
	admin(locals);
	const printer = requirePrinter(locals.user, params.id);
	const b = await body(request);
	let next;
	try {
		next = savePrinter(printer.id, b);
	} catch (err) {
		if (err instanceof SettingsError) throw new BadRequest(err.message);
		throw err;
	}
	audit(locals, 'printer.preprint', { printer, detail: `leveling: ${MODE_LABEL[next.leveling.mode].toLowerCase()}, pre-print G-code: ${MODE_LABEL[next.snippet.mode].toLowerCase()}` });
	return json({ settings: next });
});
