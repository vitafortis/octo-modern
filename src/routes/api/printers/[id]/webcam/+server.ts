import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { requirePrinter } from '#lib/server/permissions.ts';
import { webcamInfo } from '#lib/server/octoprint/webcam.ts';
import type { RequestHandler } from './$types';

/** Whether the printer has a webcam, and how to orient it. URLs stay server-side; use …/webcam/snapshot and …/webcam/stream. */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const p = requirePrinter(locals.user, params.id);
	const w = await webcamInfo(p);
	return json({ snapshot: !!w.snapshotUrl, stream: !!w.streamUrl, flipH: w.flipH, flipV: w.flipV, rotate90: w.rotate90, source: w.source });
});
