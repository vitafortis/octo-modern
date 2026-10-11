import { json } from '@sveltejs/kit';
import jpeg from 'jpeg-js';
import { body, handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { mlConfig } from '#lib/server/detect/settings.ts';
import { health } from '#lib/server/detect/obico.ts';
import { detectFrame, grabFrame } from '#lib/server/detect/service.ts';
import type { RequestHandler } from './$types';

/** A plain grey test card, so the round trip works without a camera. */
function testCard(): Uint8Array {
	const width = 320;
	const height = 240;
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		const v = 40 + (((i / 4) % width) >> 3);
		data[i] = data[i + 1] = data[i + 2] = v;
		data[i + 3] = 255;
	}
	return new Uint8Array(jpeg.encode({ width, height, data }, 80).data);
}

/**
 * Checks the setup end to end (admins): the ML API's health check, then a real
 * prediction on a frame it has to fetch back from octo·modern through a one-time link,
 * which proves both directions work. `{ printerId? }` uses that printer's webcam
 * instead of a test card.
 */
export const POST: RequestHandler = handler(async ({ locals, request }) => {
	const b = await body(request);
	const cfg = mlConfig();
	if (!cfg) return json({ ok: false, health: null, roundTrip: null, message: 'Set the ML API URL and octo·modern’s address first' });
	const hc = await health(cfg.url);
	let frame: Uint8Array;
	let source = 'test card';
	try {
		if (typeof b.printerId === 'string' && b.printerId) {
			const p = requirePrinter(locals.user, b.printerId);
			frame = (await grabFrame(p)).bytes;
			source = `${p.name} webcam`;
		} else frame = testCard();
	} catch (err) {
		return json({ ok: false, health: hc, roundTrip: { ok: false, message: (err as Error).message } });
	}
	const t0 = Date.now();
	try {
		const detections = await detectFrame(typeof b.printerId === 'string' ? b.printerId : 'test', cfg, frame);
		const ms = Date.now() - t0;
		return json({ ok: hc.ok, health: hc, roundTrip: { ok: true, ms, source, detections: detections.length, message: `${detections.length} detection${detections.length === 1 ? '' : 's'} on the ${source} in ${ms} ms` } });
	} catch (err) {
		return json({ ok: false, health: hc, roundTrip: { ok: false, source, message: (err as Error).message } });
	}
});
