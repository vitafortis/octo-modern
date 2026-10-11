import type { AnyKind, EventKind, Severity } from '#lib/notify.ts';

/** What a print looked like when the event happened (all optional). */
export interface PrintFacts {
	/** History entry id. */
	id?: number | null;
	file?: string | null;
	path?: string | null;
	startedAt?: string | null;
	endedAt?: string | null;
	/** Seconds elapsed (or the whole print time once ended). */
	elapsedS?: number | null;
	/** Seconds left, OctoPrint's estimate. */
	remainingS?: number | null;
	/** The slicer's / OctoPrint's estimate of the whole print, seconds. */
	estimatedS?: number | null;
	/** 0–100. */
	completion?: number | null;
	filamentMm?: number | null;
	startedBy?: string | null;
	cancelledBy?: string | null;
	pausedBy?: string | null;
	/** Why it failed or paused. */
	reason?: string | null;
}

/**
 * An event for `notify()`. Only `kind` is required; other features (queue, spools,
 * maintenance, failure detection, power) pass their own `title`/`message`/`fields`.
 */
export interface NotifyEvent {
	kind: EventKind;
	printerId?: string | null;
	/** Looked up from `printerId` when left out. */
	printerName?: string | null;
	title?: string;
	message?: string;
	severity?: Severity;
	print?: PrintFacts | null;
	/** Extra facts, shown as a list (Discord fields, Slack fields, email table…). */
	fields?: { label: string; value: string }[];
	/** Extra data for the webhook payload. */
	data?: Record<string, unknown>;
	/**
	 * A picture: `true` (default when there's a printer) takes a webcam snapshot,
	 * `false` sends none, or pass the bytes.
	 */
	snapshot?: boolean | Image;
	/** Same kind + printer + key within the de-dupe window is sent once. Defaults to the print. */
	dedupeKey?: string;
	/** Path in octo·modern to link to (default: the printer page). */
	link?: string;
	at?: string;
}

export interface Image {
	data: Uint8Array;
	type: string;
}

/** An event rendered once for every channel. */
export interface Message {
	kind: AnyKind;
	severity: Severity;
	title: string;
	/** One or two plain sentences. */
	text: string;
	fields: { label: string; value: string }[];
	printer: { id: string; name: string } | null;
	print: PrintFacts | null;
	/** Link back to octo·modern, when its public address is known. */
	url: string | null;
	at: string;
	data: Record<string, unknown> | null;
	image: Image | null;
	/** A public link to `image`, when "share snapshots by link" is on. */
	imageUrl: string | null;
}
