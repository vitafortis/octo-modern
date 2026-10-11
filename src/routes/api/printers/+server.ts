import { json } from '@sveltejs/kit';
import { body, handler, parsePrinterInput } from '#lib/server/http.ts';
import { createPrinter } from '#lib/server/store.ts';
import { audit, visiblePrinters, withAccess } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { resolveKind } from '#lib/server/backend/probe.ts';
import { KIND_LABEL } from '#lib/printer-kind.ts';
import type { RequestHandler } from './$types';

/** Printers the signed-in user can see. */
export const GET: RequestHandler = ({ locals }) => json(visiblePrinters(locals.user));

/**
 * Adds a printer (admins): `{ name, kind, baseUrl, apiKey?, verifyTls, webcamUrl, color }`.
 * `kind` is `octoprint` (the default, for older clients), `moonraker` or `auto` (detected
 * by probing the URL).
 */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const b = await body(request);
	if (b.kind === 'auto') {
		const draft = parsePrinterInput({ ...b, kind: undefined });
		b.kind = await resolveKind({ baseUrl: draft.baseUrl, apiKey: draft.apiKey ?? '', verifyTls: draft.verifyTls, kind: 'auto' });
	}
	const input = parsePrinterInput(b, { requireKey: true });
	const printer = createPrinter(input);
	audit(locals, 'printer.create', { printer, detail: `${printer.baseUrl} (${KIND_LABEL[printer.kind]})` });
	void printers.poll(printer.id);
	return json(withAccess(locals.user, printer), { status: 201 });
});
