/**
 * Browser push (Web Push): shapes shared by the server (src/lib/server/push/) and the
 * browser (the device list on the Account and Notifications pages). Pure.
 */

/** One device (browser profile) a person turned notifications on for. */
export interface PushDevice {
	id: string;
	/** e.g. "Safari on iPhone", from the browser's user agent. */
	label: string;
	/** The push service's URL for this device; the browser matches it to tell "this device". */
	endpoint: string;
	createdAt: string;
	lastSentAt: string | null;
	lastError: string | null;
}

/** What `GET /api/push` answers. */
export interface PushState {
	/** The VAPID public key (base64url), for `pushManager.subscribe`. */
	publicKey: string;
	devices: PushDevice[];
	/** Whether an enabled Browser push channel is used by an enabled rule. */
	channelReady: boolean;
	/** Admins only: how many devices of how many people are subscribed. */
	counts?: { devices: number; users: number };
}

/** The JSON the service worker receives in a `push` event. */
export interface PushPayload {
	title: string;
	body: string;
	/** Path inside octo·modern to open on click (same origin). */
	url: string;
	/** Notifications with the same tag replace each other (one per printer and topic). */
	tag: string;
	kind: string;
	severity: 'info' | 'success' | 'warning' | 'error';
	printerId: string | null;
	/** A snapshot by public link, when "Share snapshots by link" is on. */
	image?: string;
	at: string;
}

/** A short device name from a user agent: "Chrome on Android", "Safari on iPhone"… */
export function deviceLabel(ua: string | null | undefined): string {
	const s = ua ?? '';
	const os = /iPhone/.test(s)
		? 'iPhone'
		: /iPad/.test(s)
			? 'iPad'
			: /Android/.test(s)
				? 'Android'
				: /Windows/.test(s)
					? 'Windows'
					: /Mac OS X|Macintosh/.test(s)
						? 'macOS'
						: /CrOS/.test(s)
							? 'ChromeOS'
							: /Linux/.test(s)
								? 'Linux'
								: null;
	const browser = /Edg(e|A|iOS)?\//.test(s)
		? 'Edge'
		: /OPR\/|Opera/.test(s)
			? 'Opera'
			: /SamsungBrowser/.test(s)
				? 'Samsung Internet'
				: /Firefox\/|FxiOS/.test(s)
					? 'Firefox'
					: /Chrome\/|CriOS|Chromium/.test(s)
						? 'Chrome'
						: /Safari\//.test(s)
							? 'Safari'
							: null;
	if (browser && os) return `${browser} on ${os}`;
	return browser ?? os ?? 'Browser';
}
