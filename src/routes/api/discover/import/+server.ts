import { json } from '@sveltejs/kit';
import { BadRequest, body, handler, parsePrinterInput } from '#lib/server/http.ts';
import { createPrinter } from '#lib/server/store.ts';
import { audit, withAccess } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { testPrinter } from '#lib/server/backend/probe.ts';
import { isPrinterKind } from '#lib/types.ts';
import { appKeys } from '#lib/server/discovery/appkeys.ts';
import { setPrinterSource } from '#lib/server/discovery/config.ts';
import { recall } from '#lib/server/discovery/saved.ts';
import type { RequestHandler } from './$types';

/**
 * Saves a discovered OctoPrint (admins): `{ baseUrl, name, verifyTls, color?, key? }` plus
 * either `appKeyRequest` (an approved Application Keys request; the key never left the
 * server) or a pasted `apiKey`. A Klipper printer (`kind: 'moonraker'`, or a candidate
 * found as Moonraker) needs a key only when Moonraker asks for one. The connection is tested first; a failing test returns
 * 422 with the result unless `force` is set.
 */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const b = await body(request);
	const candidate = typeof b.key === 'string' ? recall(b.key) : undefined;
	const kind = isPrinterKind(b.kind) ? b.kind : candidate?.fingerprint.kind === 'moonraker' ? 'moonraker' : 'octoprint';
	b.kind = kind;
	const requestId = typeof b.appKeyRequest === 'string' ? b.appKeyRequest : undefined;
	const draft = parsePrinterInput({ ...b, apiKey: 'placeholder-key' });
	let apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
	if (requestId) {
		apiKey = appKeys.key(requestId, draft.baseUrl) ?? '';
		if (!apiKey) throw new BadRequest('That key request isn’t approved (or was for another address). Request a key again.');
	}
	const input = parsePrinterInput({ ...b, apiKey }, { requireKey: true });
	const test = await testPrinter({ baseUrl: input.baseUrl, apiKey: input.apiKey ?? '', verifyTls: input.verifyTls, kind });
	if (!test.ok && b.force !== true) return json({ message: test.error.message, test }, { status: 422 });

	const printer = createPrinter(input);
	if (requestId) appKeys.cancel(requestId);
	if (candidate) setPrinterSource(printer.id, candidate.source);
	audit(locals, 'printer.create', {
		printer,
		detail: `${printer.baseUrl} from Discover${candidate ? ` (${candidate.source.kind}: ${candidate.source.ref})` : ''}${requestId ? ', Application Key' : ''}`
	});
	void printers.poll(printer.id);
	return json({ printer: withAccess(locals.user, printer), test }, { status: 201 });
});
