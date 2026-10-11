import { json } from '@sveltejs/kit';
import { BadRequest, body, handler } from '#lib/server/http.ts';
import { audit, requireControl, requirePrinter } from '#lib/server/permissions.ts';
import { confirmRequired, currentState } from '#lib/server/control.ts';
import { clientFor } from '#lib/server/octoprint/manager.ts';
import { cachedPlugin, detectPlugin, driftSettings, latestMesh, listMeshes, referenceMesh, saveDriftSettings, startUpdate, updateRunning, updateState } from '#lib/server/bedmesh.ts';
import { parseDriftSettings } from '#lib/bedmesh.ts';
import { isConnected, jobActive } from '#lib/printer.ts';
import type { RequestHandler } from './$types';

const noStore = { 'cache-control': 'no-store' };

/**
 * The printer's bed meshes: `{ plugin, update, latest, history, settings, referenceId }`.
 * `?refresh=1` asks OctoPrint again (plugin installed? stored mesh changed?).
 */
export const GET: RequestHandler = handler(async ({ locals, params, url }) => {
	const printer = requirePrinter(locals.user, params.id);
	const cached = cachedPlugin(printer.id);
	const plugin = url.searchParams.has('refresh') || !cached ? await detectPlugin(printer.id) : { ...cached, stored: null };
	const { stored: _stored, ...pluginInfo } = plugin;
	const settings = driftSettings(printer.id);
	return json(
		{
			plugin: { ...pluginInfo, configured: pluginInfo.commands.length > 0 },
			update: updateState(printer.id),
			latest: latestMesh(printer.id) ?? null,
			history: listMeshes(printer.id),
			settings,
			referenceId: referenceMesh(printer.id, settings)?.id ?? null
		},
		{ headers: noStore }
	);
});

/**
 * `{ action: 'update', confirm? }`: probes the bed with the plugin's G-code (homes and moves
 * the printer, so it asks first). Refused while printing or disconnected. Operators.
 */
export const POST: RequestHandler = handler(async ({ locals, params, request }) => {
	const printer = requireControl(locals.user, params.id);
	const b = await body(request);
	if (b.action !== 'update') throw new BadRequest('Unknown action; use { "action": "update" }');
	if (updateRunning(printer.id)) return json({ message: 'A mesh update is already running on this printer' }, { status: 409 });
	const info = await detectPlugin(printer.id);
	if (info.error && !info.installed) throw new BadRequest(info.error);
	if (!info.installed) throw new BadRequest('The Bed Visualizer plugin isn’t installed on this OctoPrint');
	if (!info.commands.length) {
		return json({ message: 'The Bed Visualizer plugin has no probe G-code', hint: 'Set it in OctoPrint → Settings → Bed Visualizer → Collection (e.g. G28 and G29 T, or @BEDLEVELVISUALIZER with your firmware’s mesh report).' }, { status: 400 });
	}
	const state = await currentState(printer.id, clientFor(printer));
	if (jobActive(state)) return json({ message: 'A print is running: probing the bed would ruin it. Try again when the printer is idle.' }, { status: 409 });
	if (!isConnected(state)) return json({ message: 'The printer isn’t connected', hint: 'Connect it first; probing runs G-code on the printer.' }, { status: 409 });
	if (b.confirm !== true) {
		return confirmRequired(`The printer homes and probes the bed with: ${info.commands.join(' · ').slice(0, 200)}. Make sure the bed is clear and the nozzle is clean.`, {
			title: `Probe the bed of ${printer.name}?`,
			confirmLabel: 'Probe bed'
		});
	}
	const by = locals.user?.name ?? locals.user?.email ?? null;
	const update = await startUpdate(printer.id, info, by);
	audit(locals, 'bedmesh.update', { printer, detail: info.commands.join(' · ').slice(0, 480) });
	return json({ update }, { status: 202 });
});

/** Drift alerts: `{ enabled?, maxFlatness?, maxChange?, referenceId? }` (mm; null clears). Operators. */
export const PUT: RequestHandler = handler(async ({ locals, params, request }) => {
	const printer = requireControl(locals.user, params.id);
	const b = await body(request);
	let next;
	try {
		next = parseDriftSettings(b, driftSettings(printer.id));
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	if (next.referenceId != null) {
		const ref = listMeshes(printer.id).find((m) => m.id === next.referenceId);
		if (!ref) throw new BadRequest('That reference mesh doesn’t belong to this printer');
	}
	saveDriftSettings(printer.id, next);
	audit(locals, 'bedmesh.settings', {
		printer,
		detail: `drift alerts ${next.enabled ? 'on' : 'off'}; flatness ≤ ${next.maxFlatness ?? '—'} mm; change ≤ ${next.maxChange ?? '—'} mm; reference ${next.referenceId ?? 'oldest'}`
	});
	return json({ settings: next, referenceId: referenceMesh(printer.id, next)?.id ?? null });
});
