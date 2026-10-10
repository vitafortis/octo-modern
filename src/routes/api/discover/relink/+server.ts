import { json } from '@sveltejs/kit';
import { BadRequest, body, handler, NotFound } from '#lib/server/http.ts';
import { getPrinter, updatePrinter } from '#lib/server/store.ts';
import { audit, withAccess } from '#lib/server/permissions.ts';
import { normalizeBaseUrl } from '#lib/server/octoprint/client.ts';
import { setPrinterSource } from '#lib/server/discovery/config.ts';
import { recall } from '#lib/server/discovery/saved.ts';
import type { RequestHandler } from './$types';

/**
 * Points a saved printer at the address a fresh scan found (`{ printerId, baseUrl, key? }`),
 * keeping its name, key, color and webcam settings.
 */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const b = await body(request);
	const existing = typeof b.printerId === 'string' ? getPrinter(b.printerId) : undefined;
	if (!existing) throw new NotFound('Printer not found');
	let baseUrl: string;
	try {
		baseUrl = normalizeBaseUrl(typeof b.baseUrl === 'string' ? b.baseUrl : '');
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	const printer = updatePrinter(existing.id, { name: existing.name, baseUrl, verifyTls: existing.verifyTls, webcamUrl: existing.webcamUrl, color: existing.color })!;
	const candidate = typeof b.key === 'string' ? recall(b.key) : undefined;
	if (candidate) setPrinterSource(printer.id, candidate.source);
	audit(locals, 'printer.update', { printer, detail: `URL ${existing.baseUrl} → ${baseUrl} (from Discover)` });
	return json(withAccess(locals.user, printer));
});
