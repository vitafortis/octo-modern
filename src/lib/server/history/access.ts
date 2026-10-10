/**
 * Who sees which history entries: admins every entry (also of removed printers),
 * everyone else the entries of printers they can see.
 */
import { NotFound } from '../http.ts';
import { canSee, visiblePrinters } from '../permissions.ts';
import { getPrinter } from '../store.ts';
import { getPrint } from './store.ts';
import { RESULTS, type HistoryFilter, type PrintRecord, type PrintResult } from '#lib/history.ts';
import type { User } from '#lib/types.ts';

/** Printer ids the user's history is limited to; null for admins (no limit). */
export function historyScope(user: User | null): string[] | null {
	if (user?.role === 'admin') return null;
	return visiblePrinters(user).map((p) => p.id);
}

export function canSeeEntry(user: User | null, r: Pick<PrintRecord, 'printerId'>): boolean {
	if (user?.role === 'admin') return true;
	const p = getPrinter(r.printerId);
	return !!p && canSee(user, p);
}

/** The entry, if the user may see it (404 otherwise). */
export function requireEntry(user: User | null, rawId: string): PrintRecord {
	const id = Number(rawId);
	const r = Number.isInteger(id) && id > 0 ? getPrint(id) : undefined;
	if (!r || !canSeeEntry(user, r)) throw new NotFound('History entry not found');
	return r;
}

/** `?printer=&result=&from=&to=&q=` */
export function parseFilter(url: URL): HistoryFilter {
	const p = url.searchParams;
	const result = p.get('result') ?? '';
	return {
		printer: p.get('printer') || undefined,
		result: RESULTS.includes(result as PrintResult) ? (result as PrintResult) : undefined,
		from: p.get('from') || undefined,
		to: p.get('to') || undefined,
		q: p.get('q')?.slice(0, 200) || undefined
	};
}
