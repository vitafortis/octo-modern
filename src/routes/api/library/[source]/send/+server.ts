import { json } from '@sveltejs/kit';
import { BadRequest, body, Forbidden, handler } from '#lib/server/http.ts';
import { confirmRequired, controlTarget, currentState } from '#lib/server/control.ts';
import { requireSource, sourceAllowsPrinter } from '#lib/server/library/service.ts';
import { cleanFolder, octoprintHas, startSend } from '#lib/server/library/send.ts';
import { baseName, cleanRelPath, joinPath } from '#lib/library.ts';
import { STATE_LABEL } from '#lib/printer.ts';
import type { RequestHandler } from './$types';

/**
 * Sends a file to a printer: `{ path, printerId, folder?, print?, overwrite?, confirm? }`.
 * Answers 409 `{ exists: true }` when the printer already has a file of that name
 * (resend with `overwrite: true`), and 409 `confirmRequired` when printing was asked
 * for but the printer can't start now (resend with `confirm: true` to just upload).
 * Otherwise 202 with the transfer; poll /api/library/sends/<id>.
 */
export const POST: RequestHandler = handler(async ({ locals, params, request }) => {
	const src = requireSource(locals.user, params.source);
	const b = await body(request);
	if (typeof b.printerId !== 'string' || !b.printerId) throw new BadRequest('"printerId" is required');
	const { printer, client } = controlTarget(locals.user, b.printerId);
	if (!sourceAllowsPrinter(src, printer.id)) throw new Forbidden(`${src.name} isn’t available to ${printer.name}`);
	let path: string;
	let folder: string;
	try {
		path = cleanRelPath(b.path);
		folder = cleanFolder(b.folder);
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	if (!path) throw new BadRequest('"path" is required');
	let print = b.print === true;
	const target = joinPath(folder, baseName(path));
	if (b.overwrite !== true && (await octoprintHas(client, target))) {
		return json({ message: `${printer.name} already has ${target}. Replace it?`, exists: true, target }, { status: 409 });
	}
	if (print) {
		const state = await currentState(printer.id, client);
		if (state !== 'operational') {
			if (b.confirm !== true) {
				return confirmRequired(`${printer.name} is ${STATE_LABEL[state].toLowerCase()}, so it can’t start printing now. Send the file without printing?`);
			}
			print = false;
		}
	}
	const send = await startSend(locals, { src, path, printer, client, folder, print });
	return json(send, { status: 202 });
});
