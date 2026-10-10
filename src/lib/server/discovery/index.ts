/** Scans with saved-printer matching applied and results cached for import/relink. */
import type { Candidate } from '#lib/discovery.ts';
import { listPrinters } from '../store.ts';
import { printerSources } from './config.ts';
import { markSaved, remember } from './saved.ts';

/** Marks saved printers on these candidates and remembers them for import by key. */
export function prepare(candidates: Candidate[]): Candidate[] {
	markSaved(candidates, listPrinters(), printerSources());
	remember(candidates);
	return candidates;
}
