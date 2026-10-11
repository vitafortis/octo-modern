import type { ChannelType, Severity } from '#lib/notify.ts';
import type { Message } from '../types.ts';

export interface SendContext {
	config: Record<string, string>;
	secrets: Record<string, string>;
	message: Message;
}

/** One channel type: checks its settings and sends a rendered message. */
export interface ChannelAdapter {
	type: ChannelType;
	/** A problem with the settings, for the user, or null. Required fields are checked before this. */
	validate?(config: Record<string, string>, secrets: Record<string, string>): string | null;
	/** Throws (a DeliveryError, ideally) with the service's own answer on failure. */
	send(ctx: SendContext): Promise<void>;
}

export const COLORS: Record<Severity, number> = { success: 0x22c55e, error: 0xef4444, warning: 0xf59e0b, info: 0x8b5cf6 };

/** Text and fields as plain lines. */
export function plainBody(m: Message, { link = true } = {}): string {
	const lines = [m.text, '', ...m.fields.filter((f) => f.label !== 'Printer' || !m.text.includes(f.value)).map((f) => `${f.label}: ${f.value}`)];
	if (link && m.url) lines.push('', m.url);
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
