/** The delivery log: one row per channel per event, the newest `KEEP` kept. */
import { sqlite } from '../store.ts';
import type { Delivery, DeliveryStatus } from '#lib/notify.ts';

const KEEP = 500;

export function logDelivery(d: Omit<Delivery, 'id' | 'at'> & { at?: string }) {
	try {
		const h = sqlite();
		const r = h
			.prepare('INSERT INTO notify_log (at, channel_id, channel_name, channel_type, kind, printer_name, title, status, error, ms, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.run(d.at ?? new Date().toISOString(), d.channelId, d.channelName, d.channelType, d.kind, d.printerName, d.title.slice(0, 250), d.status, d.error?.slice(0, 1000) ?? null, d.ms, d.image ? 1 : 0);
		const id = Number(r.lastInsertRowid);
		if (id % 50 === 0) h.prepare('DELETE FROM notify_log WHERE id <= ?').run(id - KEEP);
	} catch (err) {
		console.error('[octo-modern] notification log write failed', err);
	}
}

export function listDeliveries(limit = 100, status?: DeliveryStatus): Delivery[] {
	const n = Math.max(1, Math.min(KEEP, Math.floor(limit)));
	const rows = (
		status
			? sqlite().prepare('SELECT * FROM notify_log WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, n)
			: sqlite().prepare('SELECT * FROM notify_log ORDER BY id DESC LIMIT ?').all(n)
	) as Record<string, unknown>[];
	return rows.map((r) => ({
		id: r.id as number,
		at: r.at as string,
		channelId: r.channel_id as string,
		channelName: r.channel_name as string,
		channelType: r.channel_type as string,
		kind: r.kind as string,
		printerName: (r.printer_name as string) ?? null,
		title: r.title as string,
		status: r.status as DeliveryStatus,
		error: (r.error as string) ?? null,
		ms: (r.ms as number) ?? null,
		image: r.image === 1
	}));
}

export function clearDeliveries() {
	sqlite().prepare('DELETE FROM notify_log').run();
}
