/**
 * Marks candidates that are already saved printers: same address (any of the
 * candidate's addresses), or the same container / mDNS instance / host it was imported
 * from. A match by identity at an address the scan doesn't use is "address changed".
 * Scans are cached briefly so import and relink can refer to a candidate by key.
 */
import { addressKey, type Candidate } from '#lib/discovery.ts';
import type { Printer } from '#lib/types.ts';

type Source = { kind: string; ref: string };

export function matchSaved(c: Candidate, printers: Pick<Printer, 'id' | 'name' | 'baseUrl'>[], sources: Record<string, Source>): Candidate['saved'] {
	const primary = addressKey(c.baseUrl);
	const all = new Map<string, boolean | undefined>([[primary, c.reachable], ...c.alternates.map((a) => [addressKey(a.url), a.reachable] as [string, boolean | undefined])]);
	const atAddress = printers.find((p) => all.has(addressKey(p.baseUrl)));
	const byIdentity = printers.find((p) => sources[p.id]?.kind === c.source.kind && sources[p.id]?.ref === c.source.ref);
	const match = atAddress ?? byIdentity;
	if (!match) return undefined;
	const savedKey = addressKey(match.baseUrl);
	// Saved on one of this candidate's addresses, but one the scan found unreachable while the primary answers.
	const better = !!atAddress && savedKey !== primary && c.reachable && all.get(savedKey) === false;
	return { id: match.id, name: match.name, baseUrl: match.baseUrl, addressChanged: !atAddress || better };
}

export function markSaved<T extends Candidate>(candidates: T[], printers: Pick<Printer, 'id' | 'name' | 'baseUrl'>[], sources: Record<string, Source>): T[] {
	for (const c of candidates) c.saved = matchSaved(c, printers, sources);
	return candidates;
}

// --- scan cache ------------------------------------------------------------------

const TTL_MS = 30 * 60_000;
const recent = new Map<string, { candidate: Candidate; at: number }>();

export function remember(candidates: Candidate[]) {
	const now = Date.now();
	for (const [k, v] of recent) if (now - v.at > TTL_MS) recent.delete(k);
	for (const c of candidates) recent.set(c.key, { candidate: c, at: now });
}

export function recall(key: string): Candidate | undefined {
	return recent.get(key)?.candidate;
}
