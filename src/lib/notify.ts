/**
 * Notifications: event kinds, channel types and their settings forms. Shared by the
 * server (src/lib/server/notify/) and the browser (the Notifications page). Pure.
 */

export type Severity = 'info' | 'success' | 'warning' | 'error';

/**
 * Everything octo·modern can notify about. The `queue.*`, `spool.*`, `maintenance.*`,
 * `failure.*` and `power.*` kinds are raised by other features through `notify()`;
 * they render generically (title, message, fields).
 */
export const EVENT_KINDS = [
	'print.started',
	'print.progress',
	'print.paused',
	'print.finished',
	'print.failed',
	'print.cancelled',
	'print.prestart_failed',
	'printer.offline',
	'printer.error',
	'printer.online',
	'printer.hot',
	'queue.bed_clear_needed',
	'spool.low',
	'maintenance.due',
	'failure.suspected',
	'power.on',
	'power.off',
	'bed.drift'
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];
/** Plus `test`, which only "Send test" uses (never routed). */
export type AnyKind = EventKind | 'test';

export interface EventInfo {
	label: string;
	group: 'Prints' | 'Printer' | 'Other features';
	severity: Severity;
	/** One line for the rules editor. */
	hint: string;
}

export const EVENT_INFO: Record<AnyKind, EventInfo> = {
	'print.started': { label: 'Print started', group: 'Prints', severity: 'info', hint: 'A print begins' },
	'print.progress': { label: 'Progress milestone', group: 'Prints', severity: 'info', hint: 'At the percentages and "minutes left" set below' },
	'print.paused': { label: 'Print paused', group: 'Prints', severity: 'warning', hint: 'Including filament runout, M600 and pauses in the G-code' },
	'print.finished': { label: 'Print finished', group: 'Prints', severity: 'success', hint: 'Done, 100 %' },
	'print.failed': { label: 'Print failed', group: 'Prints', severity: 'error', hint: 'An error or a lost connection ended it' },
	'print.cancelled': { label: 'Print cancelled', group: 'Prints', severity: 'warning', hint: 'Someone cancelled it (and who)' },
	'print.prestart_failed': { label: 'Pre-print steps failed', group: 'Prints', severity: 'error', hint: 'Bed leveling or the pre-print G-code failed or timed out, so the print wasn’t started' },
	'printer.offline': { label: 'Printer offline', group: 'Printer', severity: 'error', hint: 'OctoPrint unreachable or the printer disconnected, after the grace period' },
	'printer.error': { label: 'Printer error', group: 'Printer', severity: 'error', hint: 'The printer reports an error state' },
	'printer.online': { label: 'Printer back', group: 'Printer', severity: 'success', hint: 'After an offline or error notification' },
	'printer.hot': { label: 'Still hot after print', group: 'Printer', severity: 'warning', hint: 'Bed or hotend above the threshold N minutes after a print' },
	'queue.bed_clear_needed': { label: 'Bed clear needed', group: 'Other features', severity: 'warning', hint: 'The print queue waits for someone to clear the bed' },
	'spool.low': { label: 'Spool low', group: 'Other features', severity: 'warning', hint: 'Filament on a spool is running low' },
	'maintenance.due': { label: 'Maintenance due', group: 'Other features', severity: 'info', hint: 'A maintenance task is due' },
	'failure.suspected': { label: 'Failure suspected', group: 'Other features', severity: 'error', hint: 'Failure detection: a warning or a failure, with the annotated frame' },
	'power.on': { label: 'Power on', group: 'Other features', severity: 'info', hint: 'A printer’s smart plug was switched on' },
	'power.off': { label: 'Power off', group: 'Other features', severity: 'info', hint: 'A printer’s smart plug was switched off' },
	'bed.drift': { label: 'Bed mesh drift', group: 'Other features', severity: 'warning', hint: 'A new bed mesh is less flat, or moved from the reference, beyond the limits set in the Bed tab' },
	test: { label: 'Test', group: 'Other features', severity: 'info', hint: 'Send test' }
};

/** Kinds whose severity is `error`: these pass quiet hours when a channel allows it. */
export const isCritical = (severity: Severity) => severity === 'error';

// --- channel types ------------------------------------------------------------

export type ChannelType = 'ntfy' | 'discord' | 'slack' | 'telegram' | 'pushover' | 'gotify' | 'matrix' | 'email' | 'homeassistant' | 'webhook' | 'push';

export interface FieldDef {
	key: string;
	label: string;
	/** `secret`: sealed at rest, never sent back to the browser (only a hint). */
	kind: 'text' | 'url' | 'secret' | 'number' | 'select' | 'toggle' | 'email';
	required?: boolean;
	placeholder?: string;
	help?: string;
	options?: { value: string; label: string }[];
	default?: string;
	/** Half width in the form grid. */
	half?: boolean;
}

export interface ChannelTypeInfo {
	type: ChannelType;
	label: string;
	blurb: string;
	/** How a snapshot travels: attached, or only by link (needs "Share snapshots by link"). */
	images: 'attach' | 'link' | 'none';
	fields: FieldDef[];
}

const secret = (key: string, label: string, opts: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: 'secret', ...opts });

export const CHANNEL_TYPES: ChannelTypeInfo[] = [
	{
		type: 'ntfy',
		label: 'ntfy',
		blurb: 'Push to the ntfy app, ntfy.sh or your own server',
		images: 'attach',
		fields: [
			{ key: 'server', label: 'Server', kind: 'url', placeholder: 'https://ntfy.sh', default: 'https://ntfy.sh', half: true },
			{ key: 'topic', label: 'Topic', kind: 'text', required: true, placeholder: 'my-printers', half: true },
			secret('token', 'Access token', { placeholder: 'optional', help: 'For protected topics (tk_…).' })
		]
	},
	{
		type: 'discord',
		label: 'Discord',
		blurb: 'A message with an embed and the snapshot in a channel',
		images: 'attach',
		fields: [secret('url', 'Webhook URL', { required: true, placeholder: 'https://discord.com/api/webhooks/…', help: 'Channel settings → Integrations → Webhooks.' })]
	},
	{
		type: 'slack',
		label: 'Slack',
		blurb: 'Block Kit message through an incoming webhook',
		images: 'link',
		fields: [secret('url', 'Incoming webhook URL', { required: true, placeholder: 'https://hooks.slack.com/services/…' })]
	},
	{
		type: 'telegram',
		label: 'Telegram',
		blurb: 'A bot sends the photo with a caption, or a message',
		images: 'attach',
		fields: [
			secret('botToken', 'Bot token', { required: true, placeholder: '123456:ABC…', help: 'From @BotFather.' }),
			{ key: 'chatId', label: 'Chat ID', kind: 'text', required: true, placeholder: '-1001234567890 or @channel', half: true },
			{ key: 'server', label: 'Bot API server', kind: 'url', placeholder: 'https://api.telegram.org', default: 'https://api.telegram.org', half: true, help: 'Only change for a self-hosted Bot API server.' }
		]
	},
	{
		type: 'pushover',
		label: 'Pushover',
		blurb: 'Push with the snapshot attached; failures at high priority',
		images: 'attach',
		fields: [
			secret('appToken', 'Application token', { required: true, half: true }),
			secret('userKey', 'User or group key', { required: true, half: true }),
			{ key: 'device', label: 'Device', kind: 'text', placeholder: 'all devices', half: true },
			{ key: 'sound', label: 'Sound', kind: 'text', placeholder: 'default', half: true }
		]
	},
	{
		type: 'gotify',
		label: 'Gotify',
		blurb: 'Self-hosted push; markdown with a click-through link',
		images: 'link',
		fields: [
			{ key: 'server', label: 'Server', kind: 'url', required: true, placeholder: 'https://gotify.lan', half: true },
			secret('appToken', 'Application token', { required: true, half: true })
		]
	},
	{
		type: 'matrix',
		label: 'Matrix',
		blurb: 'Posts to a room; the snapshot is uploaded as an image',
		images: 'attach',
		fields: [
			{ key: 'homeserver', label: 'Homeserver', kind: 'url', required: true, placeholder: 'https://matrix.org', half: true },
			{ key: 'roomId', label: 'Room ID', kind: 'text', required: true, placeholder: '!abcdef:matrix.org', half: true, help: 'Room settings → Advanced. The account must have joined it.' },
			secret('accessToken', 'Access token', { required: true, help: 'Of a bot account, e.g. from Element: Settings → Help & About.' })
		]
	},
	{
		type: 'email',
		label: 'Email (SMTP)',
		blurb: 'HTML email with the snapshot attached',
		images: 'attach',
		fields: [
			{ key: 'host', label: 'SMTP server', kind: 'text', required: true, placeholder: 'smtp.example.com', half: true },
			{ key: 'port', label: 'Port', kind: 'number', placeholder: '587', default: '587', half: true },
			{
				key: 'security',
				label: 'Security',
				kind: 'select',
				default: 'starttls',
				half: true,
				options: [
					{ value: 'starttls', label: 'STARTTLS (587)' },
					{ value: 'tls', label: 'TLS (465)' },
					{ value: 'none', label: 'None (trusted LAN only)' }
				]
			},
			{ key: 'username', label: 'Username', kind: 'text', placeholder: 'optional', half: true },
			secret('password', 'Password', { placeholder: 'optional' }),
			{ key: 'from', label: 'From', kind: 'email', required: true, placeholder: 'octo-modern@example.com', half: true },
			{ key: 'to', label: 'To', kind: 'text', required: true, placeholder: 'me@example.com, you@example.com', half: true },
			{ key: 'allowSelfSigned', label: 'Accept a self-signed certificate', kind: 'toggle' }
		]
	},
	{
		type: 'homeassistant',
		label: 'Home Assistant',
		blurb: 'Trigger an automation by webhook and/or call a notify service',
		images: 'link',
		fields: [
			{ key: 'baseUrl', label: 'Home Assistant URL', kind: 'url', required: true, placeholder: 'http://homeassistant.local:8123' },
			secret('webhookId', 'Webhook ID', { half: true, placeholder: 'for a webhook trigger', help: 'Receives the same JSON as a generic webhook.' }),
			{ key: 'service', label: 'Notify service', kind: 'text', half: true, placeholder: 'mobile_app_my_phone', help: 'notify.<service>; needs a token.' },
			secret('token', 'Long-lived access token', { placeholder: 'for the notify service', help: 'Your profile → Security → Long-lived access tokens.' })
		]
	},
	{
		// Browser push (Web Push): delivered to the devices people enabled on their Account page.
		type: 'push',
		label: 'Browser push',
		blurb: 'To the phones and computers people turned notifications on for',
		images: 'link',
		fields: [
			{
				key: 'audience',
				label: 'Who gets it',
				kind: 'select',
				default: 'all',
				options: [
					{ value: 'all', label: 'Everyone who can see the printer' },
					{ value: 'control', label: 'Operators and admins who can see it' },
					{ value: 'admin', label: 'Admins only' }
				],
				help: 'Each person enables it per device (My account → Browser push). People only get printers they have access to.'
			}
		]
	},
	{
		type: 'webhook',
		label: 'Webhook (JSON)',
		blurb: 'POSTs a JSON document to any URL',
		images: 'attach',
		fields: [
			secret('url', 'URL', { required: true, placeholder: 'https://…' }),
			secret('authorization', 'Authorization header', { placeholder: 'optional, e.g. Bearer …' }),
			{
				key: 'format',
				label: 'Payload',
				kind: 'select',
				default: '2',
				half: true,
				options: [
					{ value: '2', label: 'Version 2 (all events)' },
					{ value: '1', label: 'Version 1 (as before)' }
				]
			},
			{ key: 'includeImage', label: 'Include the snapshot (base64)', kind: 'toggle' }
		]
	}
];

export const CHANNEL_TYPE_MAP = Object.fromEntries(CHANNEL_TYPES.map((t) => [t.type, t])) as Record<ChannelType, ChannelTypeInfo>;
export const isChannelType = (v: unknown): v is ChannelType => typeof v === 'string' && v in CHANNEL_TYPE_MAP;

// --- settings shapes (as the browser sees them) ----------------------------------

export interface QuietHours {
	enabled: boolean;
	/** `HH:MM`, server local time. */
	start: string;
	end: string;
	/** 0 = Sunday … 6; empty = every day. The day is the one the quiet period starts on. */
	days: number[];
	/** Errors and failures still go through. */
	allowCritical: boolean;
}

export const DEFAULT_QUIET: QuietHours = { enabled: false, start: '22:00', end: '07:00', days: [], allowCritical: true };

export interface ChannelInfo {
	id: string;
	type: ChannelType;
	name: string;
	enabled: boolean;
	config: Record<string, string>;
	/** Which secrets are set, as hints (`hooks.slack.com/…`, `••••••`). */
	secrets: Record<string, string>;
	quiet: QuietHours;
	lastError: string | null;
	lastSentAt: string | null;
}

export interface Rule {
	id: string;
	name: string;
	enabled: boolean;
	/** `all` or printer ids. */
	printers: 'all' | string[];
	events: EventKind[];
	/** Channel ids. */
	channels: string[];
}

export interface GeneralSettings {
	/** octo·modern's address for links (and snapshot links); falls back to ORIGIN. */
	publicUrl: string | null;
	/** Serve snapshots at unguessable links for channels that can only show images by URL. */
	mediaLinks: boolean;
	/** The same event (kind, printer, print) goes to a channel at most once in this many minutes. */
	dedupeMinutes: number;
	/** At most this many messages per channel in 10 minutes. */
	ratePer10Min: number;
	progressPercents: number[];
	progressMinutesLeft: number[];
	hot: { minutes: number; bedC: number; hotendC: number };
	/** How long a printer must stay offline before `printer.offline`. */
	offlineGraceS: number;
}

export const DEFAULT_GENERAL: GeneralSettings = {
	publicUrl: null,
	mediaLinks: false,
	dedupeMinutes: 10,
	ratePer10Min: 20,
	progressPercents: [25, 50, 75],
	progressMinutesLeft: [10],
	hot: { minutes: 15, bedC: 40, hotendC: 50 },
	offlineGraceS: 120
};

export type DeliveryStatus = 'sent' | 'failed' | 'quiet' | 'deduped' | 'rate_limited';

export interface Delivery {
	id: number;
	at: string;
	channelId: string;
	channelName: string;
	channelType: string;
	kind: string;
	printerName: string | null;
	title: string;
	status: DeliveryStatus;
	error: string | null;
	ms: number | null;
	image: boolean;
}
