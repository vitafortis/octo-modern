import { json } from '@sveltejs/kit';
import { body, handler, NotFound, parsePrinterInput } from '#lib/server/http.ts';
import { deletePrinter, getPrinter, updatePrinter } from '#lib/server/store.ts';
import { audit, requirePrinter, withAccess } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { KIND_LABEL } from '#lib/printer-kind.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(({ params, locals }) => json(withAccess(locals.user, requirePrinter(locals.user, params.id))));

/** Edits a server (admins). Omit `apiKey` to keep the stored one, `kind` to keep the type. */
export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	const before = getPrinter(params.id);
	if (!before) throw new NotFound('Printer not found');
	const b = await body(request);
	const input = parsePrinterInput({ ...b, kind: b.kind === 'auto' ? undefined : b.kind });
	const printer = updatePrinter(params.id, input)!;
	const changes = [
		before.name !== printer.name && `name ${printer.name}`,
		before.kind !== printer.kind && `type ${KIND_LABEL[printer.kind]}`,
		before.baseUrl !== printer.baseUrl && `URL ${printer.baseUrl}`,
		input.apiKey !== undefined && 'API key replaced',
		before.verifyTls !== printer.verifyTls && `verify TLS ${printer.verifyTls ? 'on' : 'off'}`,
		before.webcamUrl !== printer.webcamUrl && 'webcam URL'
	].filter(Boolean);
	audit(locals, 'printer.update', { printer, detail: changes.join(', ') || 'no changes' });
	return json(withAccess(locals.user, printer));
});

/** Removes a server from octo·modern (admins). OctoPrint itself is untouched. */
export const DELETE: RequestHandler = handler(({ params, locals }) => {
	const printer = getPrinter(params.id);
	if (!printer) throw new NotFound('Printer not found');
	deletePrinter(printer.id);
	printers.forget(printer.id);
	audit(locals, 'printer.delete', { printer, detail: printer.baseUrl });
	return json({ ok: true });
});
