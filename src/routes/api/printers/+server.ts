import { json } from '@sveltejs/kit';
import { body, handler, parsePrinterInput } from '#lib/server/http.ts';
import { createPrinter } from '#lib/server/store.ts';
import { audit, visiblePrinters, withAccess } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import type { RequestHandler } from './$types';

/** Printers the signed-in user can see. */
export const GET: RequestHandler = ({ locals }) => json(visiblePrinters(locals.user));

/** Adds an OctoPrint server (admins). */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const input = parsePrinterInput(await body(request), { requireKey: true });
	const printer = createPrinter(input);
	audit(locals, 'printer.create', { printer, detail: printer.baseUrl });
	void printers.poll(printer.id);
	return json(withAccess(locals.user, printer), { status: 201 });
});
