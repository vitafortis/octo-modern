/**
 * Terminal line filters (the noise OctoPrint's own terminal can suppress), search, and
 * how a line is shown. Lines are OctoPrint's serial log: `Send: G28`, `Recv: ok`,
 * `Recv:  T:210.0 /210.0 B:60.0 /60.0`, plus OctoPrint's own messages. Pure.
 */

export type FilterId = 'temperature' | 'ok' | 'sd' | 'wait' | 'busy';

export interface TerminalFilter {
	id: FilterId;
	label: string;
	hint: string;
	test: (line: string) => boolean;
}

/** Temperature polls and reports: `Send: M105`, `Recv: ok T:…`, `Recv:  T:… B:…`, auto-reports. */
const TEMP_RE = /^(?:Send:\s*(?:N\d+\s+)?M105\b|Recv:\s+(?:ok\s+(?:[PBN]\d+\s+)*)?(?:[BCLPR]|T\d*):\s*-?\d)/;
/** Bare acknowledgements: `Recv: ok`, `Recv: ok N12 P15 B3`. */
const OK_RE = /^Recv:\s*ok(?:\s+(?:[PBN]\d+\s*)*)?$/;
/** SD progress polling: `Send: M27`, `Recv: SD printing byte 1234/5678`, `Recv: Not SD printing`. */
const SD_RE = /^(?:Send:\s*(?:N\d+\s+)?M27\b|Recv:\s*(?:SD printing byte|Not SD printing))/;
/** `Recv: wait` (the firmware idling between commands). */
const WAIT_RE = /^Recv:\s*wait\s*$/;
/** `Recv: echo:busy: processing` (Marlin's host keepalive). */
const BUSY_RE = /^Recv:\s*(?:echo:\s*)?busy:\s*(?:processing|paused for user|paused for input)/;

export const FILTERS: TerminalFilter[] = [
	{ id: 'temperature', label: 'Temperatures', hint: 'M105 polls and T:/B: reports', test: (l) => TEMP_RE.test(l) },
	{ id: 'ok', label: 'ok', hint: 'Plain “ok” acknowledgements', test: (l) => OK_RE.test(l) },
	{ id: 'sd', label: 'SD status', hint: 'M27 polls and SD progress', test: (l) => SD_RE.test(l) },
	{ id: 'wait', label: 'wait', hint: '“wait” while the firmware is idle', test: (l) => WAIT_RE.test(l) },
	{ id: 'busy', label: 'busy', hint: '“echo:busy: processing” keepalives', test: (l) => BUSY_RE.test(l) }
];

/** Filters that start hidden: OctoPrint's terminal hides the same by default-ish, and they drown everything else. */
export const DEFAULT_HIDDEN: FilterId[] = ['temperature', 'sd', 'wait'];

/** A line passes when no enabled filter hides it. */
export function makeLineFilter(hidden: Iterable<FilterId>): (line: string) => boolean {
	const active = FILTERS.filter((f) => new Set(hidden).has(f.id));
	if (!active.length) return () => true;
	return (line) => !active.some((f) => f.test(line));
}

/** Case-insensitive search; an empty query matches everything. */
export function matchesSearch(line: string, query: string): boolean {
	const q = query.trim().toLowerCase();
	return !q || line.toLowerCase().includes(q);
}

/** Splits a line into plain and highlighted parts for a search query. */
export function highlight(line: string, query: string): { text: string; hit: boolean }[] {
	const q = query.trim();
	if (!q) return [{ text: line, hit: false }];
	const parts: { text: string; hit: boolean }[] = [];
	const lower = line.toLowerCase();
	const ql = q.toLowerCase();
	let at = 0;
	for (let i = lower.indexOf(ql); i !== -1; i = lower.indexOf(ql, i + ql.length)) {
		if (i > at) parts.push({ text: line.slice(at, i), hit: false });
		parts.push({ text: line.slice(i, i + q.length), hit: true });
		at = i + q.length;
	}
	if (at < line.length) parts.push({ text: line.slice(at), hit: false });
	return parts;
}

export type LineKind = 'send' | 'recv' | 'error' | 'warn' | 'info';

/** How a line is coloured: what was sent, what came back, errors and OctoPrint's own messages. */
export function lineKind(line: string): LineKind {
	if (/^Recv:\s*(?:Error|!!)|^(?:Unexpected error|Error:|There was a timeout)|Printer halted|kill\(\) called/i.test(line)) return 'error';
	if (/^Recv:\s*(?:echo:)?\s*(?:Warning|\/\/ ?action:)|^Recv:\s*Resend\b|^No response from printer/i.test(line)) return 'warn';
	if (line.startsWith('Send:')) return 'send';
	if (line.startsWith('Recv:')) return 'recv';
	return 'info';
}
