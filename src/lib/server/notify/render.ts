/**
 * Turns an event into the message every channel formats its own way: a title, a
 * sentence, a list of facts and a link back. Pure.
 */
import { EVENT_INFO } from '#lib/notify.ts';
import { formatDuration } from '#lib/printer.ts';
import type { Message, NotifyEvent, PrintFacts } from './types.ts';

export const trimSlash = (s: string) => s.replace(/\/+$/, '');
const pct = (n: number) => `${Math.round(n)}%`;
const metres = (mm: number) => `${(mm / 1000).toFixed(2)} m`;

/** Facts about the print, in a fixed order, skipping what's unknown. */
export function printFields(p: PrintFacts | null | undefined, kind: string): { label: string; value: string }[] {
	if (!p) return [];
	const out: { label: string; value: string }[] = [];
	const ended = kind === 'print.finished' || kind === 'print.failed' || kind === 'print.cancelled';
	if (p.file) out.push({ label: 'File', value: p.file });
	if (p.completion != null && kind !== 'print.finished') out.push({ label: 'Progress', value: pct(p.completion) });
	if (p.elapsedS != null) out.push({ label: ended ? 'Print time' : 'Elapsed', value: formatDuration(p.elapsedS) });
	if (p.remainingS != null && !ended) out.push({ label: 'Remaining', value: formatDuration(p.remainingS) });
	if (p.estimatedS != null) out.push({ label: 'Estimate', value: formatDuration(p.estimatedS) });
	if (p.filamentMm) out.push({ label: 'Filament', value: metres(p.filamentMm) });
	if (p.startedBy) out.push({ label: 'Started by', value: p.startedBy });
	if (p.pausedBy) out.push({ label: 'Paused by', value: p.pausedBy });
	if (p.cancelledBy) out.push({ label: 'Cancelled by', value: p.cancelledBy });
	if (p.reason) out.push({ label: 'Reason', value: p.reason });
	return out;
}

function defaultText(ev: NotifyEvent, printer: string | null): { title: string; text: string } {
	const p = ev.print ?? {};
	const file = p.file ?? null;
	const who = printer ?? 'A printer';
	const after = p.elapsedS != null ? ` after ${formatDuration(p.elapsedS)}` : '';
	switch (ev.kind) {
		case 'print.started':
			return {
				title: `Print started: ${file ?? who}`,
				text: `${who}: ${file ?? 'a print'} started${p.startedBy ? ` by ${p.startedBy}` : ''}${p.estimatedS ? `, about ${formatDuration(p.estimatedS)}` : ''}.`
			};
		case 'print.progress':
			return {
				title: `${p.completion != null ? pct(p.completion) : 'Progress'}: ${file ?? who}`,
				text: `${who}: ${file ?? 'the print'} is ${p.completion != null ? `${pct(p.completion)} done` : 'running'}${p.remainingS != null ? `, ${formatDuration(p.remainingS)} left` : ''}.`
			};
		case 'print.paused':
			return {
				title: `Print paused: ${file ?? who}`,
				text: `${who}: ${file ?? 'the print'} paused${p.completion != null ? ` at ${pct(p.completion)}` : ''}${p.reason ? ` (${p.reason})` : ''}${p.pausedBy ? `, by ${p.pausedBy}` : ''}.`
			};
		case 'print.finished':
		case 'print.failed':
		case 'print.cancelled': {
			const word = ev.kind === 'print.finished' ? 'finished' : ev.kind === 'print.failed' ? 'failed' : 'cancelled';
			const parts = [
				p.elapsedS != null ? `after ${formatDuration(p.elapsedS)}` : null,
				ev.kind !== 'print.finished' && p.completion != null ? `at ${pct(p.completion)}` : null,
				p.filamentMm ? `${metres(p.filamentMm)} filament` : null,
				p.reason && ev.kind === 'print.failed' ? `reason: ${p.reason}` : null,
				p.cancelledBy ? `cancelled by ${p.cancelledBy}` : null,
				p.startedBy ? `started by ${p.startedBy}` : null
			].filter(Boolean);
			return {
				title: `${EVENT_INFO[ev.kind].label}: ${file ?? who}`,
				text: `${who}: ${file ?? 'the print'} ${word}${parts.length ? ` ${parts.join(', ')}` : ''}.`
			};
		}
		case 'printer.offline':
			return { title: `${who} is offline`, text: `${who} went offline${after}.` };
		case 'printer.error':
			return { title: `${who}: printer error`, text: `${who} reports an error.` };
		case 'printer.online':
			return { title: `${who} is back`, text: `${who} is reachable and connected again.` };
		case 'printer.hot':
			return { title: `${who} is still hot`, text: `${who} is still hot after the print.` };
		default:
			return { title: printer ? `${EVENT_INFO[ev.kind].label}: ${printer}` : EVENT_INFO[ev.kind].label, text: `${EVENT_INFO[ev.kind].label}${printer ? ` on ${printer}` : ''}.` };
	}
}

/** The message for an event; `printerName` is the stored name when the event has none. */
export function render(ev: NotifyEvent, opts: { publicUrl: string | null; printerName?: string | null; at?: string }): Message {
	const name = ev.printerName ?? opts.printerName ?? null;
	const { title, text } = defaultText(ev, name);
	const base = opts.publicUrl ? trimSlash(opts.publicUrl) : null;
	let url: string | null = null;
	if (base) {
		if (ev.link) url = `${base}${ev.link.startsWith('/') ? '' : '/'}${ev.link}`;
		else if (ev.printerId) {
			const ended = ev.kind === 'print.finished' || ev.kind === 'print.failed' || ev.kind === 'print.cancelled';
			url = `${base}/p/${encodeURIComponent(ev.printerId)}${ended ? '?tab=history' : ''}`;
		} else url = base;
	}
	const fields = [...(name ? [{ label: 'Printer', value: name }] : []), ...printFields(ev.print, ev.kind), ...(ev.fields ?? [])]
		.filter((f) => f && typeof f.label === 'string' && f.value != null && String(f.value) !== '')
		.map((f) => ({ label: f.label.slice(0, 80), value: String(f.value).slice(0, 500) }))
		.slice(0, 20);
	return {
		kind: ev.kind,
		severity: ev.severity ?? EVENT_INFO[ev.kind].severity,
		title: (ev.title ?? title).slice(0, 250),
		text: (ev.message ?? text).slice(0, 2000),
		fields,
		printer: ev.printerId ? { id: ev.printerId, name: name ?? ev.printerId } : null,
		print: ev.print ?? null,
		url,
		at: ev.at ?? opts.at ?? new Date().toISOString(),
		data: ev.data ?? null,
		image: null,
		imageUrl: null
	};
}

/** The message "Send test" sends. */
export function testMessage(publicUrl: string | null, channelName: string): Message {
	return {
		kind: 'test',
		severity: 'info',
		title: 'Test from octo·modern',
		text: `Notifications reach ${channelName}.`,
		fields: [{ label: 'Channel', value: channelName }],
		printer: null,
		print: null,
		url: publicUrl ? trimSlash(publicUrl) : null,
		at: new Date().toISOString(),
		data: null,
		image: null,
		imageUrl: null
	};
}
