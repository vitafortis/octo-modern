import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit, requireControl, requirePrinter } from '#lib/server/permissions.ts';
import { parsePrinterSettings, printerSettings, savePrinterSettings } from '#lib/server/detect/settings.ts';
import { status } from '#lib/server/detect/service.ts';
import type { RequestHandler } from './$types';

/** The printer's failure detection: settings, phase, score history, last frame's boxes. */
export const GET: RequestHandler = handler(({ params, locals }) => {
	const p = requirePrinter(locals.user, params.id);
	return json(status(p.id));
});

/** Changes settings: `{ enabled?, sensitivity?, onFailure?, intervalS?, skipMinutes? }` (operators and admins). */
export const PUT: RequestHandler = handler(async ({ params, locals, request }) => {
	const p = requireControl(locals.user, params.id);
	const prev = printerSettings(p.id);
	let next;
	try {
		next = parsePrinterSettings(prev, await body(request));
	} catch (err) {
		if (err instanceof BadRequest) throw err;
		throw new BadRequest((err as Error).message);
	}
	savePrinterSettings(p.id, next);
	const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== prev[k]).map((k) => `${k} ${prev[k]} → ${next[k]}`);
	if (changed.length) audit(locals, 'detect.settings', { printer: p, detail: changed.join(', ') });
	return json(status(p.id));
});
