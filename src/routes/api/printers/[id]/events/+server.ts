import { handler } from '#lib/server/http.ts';
import { canSee, requirePrinter } from '#lib/server/permissions.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { sseResponse } from '#lib/server/sse.ts';
import { getPrinter, getUser } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/**
 * Live printer state as Server-Sent Events. While at least one browser listens, the
 * server keeps a push connection to OctoPrint open.
 *
 *   event: snapshot  { snapshot, history, logs, busyFiles, push }   first, and after the history is rebuilt
 *   event: update    { snapshot, samples }                           state changed / new temperature points
 *   event: log       { lines, reset? }                               terminal lines
 *   event: octoprint { name, payload }                               OctoPrint events (PrintStarted, FileAdded, …)
 *   event: plugin    { plugin, data }                                plugin push messages
 */
export const GET: RequestHandler = handler(({ params, locals, request }) => {
	const printer = requirePrinter(locals.user, params.id);
	const userId = locals.user?.id;
	return sseResponse(
		request.signal,
		(ch) => {
			const model = printers.model(printer.id)!;
			const sendSnapshot = () =>
				ch.send('snapshot', { snapshot: model.snapshot, history: model.history.toArray(), logs: model.logs, busyFiles: model.busyFiles, push: printers.pushState(printer.id) });
			sendSnapshot();
			const off = printers.subscribe(printer.id, (e) => {
				if (e.type === 'update') ch.send('update', { snapshot: e.snapshot, samples: e.samples, busyFiles: model.busyFiles });
				else if (e.type === 'history') sendSnapshot();
				else if (e.type === 'log') ch.send('log', { lines: e.lines, reset: e.reset ?? false });
				else if (e.type === 'event') ch.send('octoprint', { name: e.name, payload: e.payload });
				else if (e.type === 'plugin') ch.send('plugin', { plugin: e.plugin, data: e.data });
			});
			// Fresh data right away if the push connection still has to start.
			if (model.snapshot.source !== 'push') void printers.poll(printer.id);
			return off;
		},
		{
			// Drop the stream when the user loses access or the printer is removed.
			onPing: (ch) => {
				const p = getPrinter(printer.id);
				if (!p) return ch.close();
				if (userId && userId !== 'open') {
					const u = getUser(userId);
					if (!u || u.disabled || !canSee(u, p)) ch.close();
				}
			}
		}
	);
});
