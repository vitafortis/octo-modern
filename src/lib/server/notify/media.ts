/**
 * Snapshots shared by link, for channels that can only show an image by URL (Slack,
 * Gotify, Home Assistant's notify service). Each gets a random 256-bit token; only its
 * SHA-256 is stored, and links expire after `TTL_MS`. Served without sign-in at
 * /api/notify/media/<token>, so this is opt-in ("Share snapshots by link").
 */
import { randomToken, sha256 } from '../crypto.ts';
import { sqlite } from '../store.ts';
import { trimSlash } from './render.ts';
import type { Image } from './types.ts';

export const TTL_MS = 48 * 3600_000;
export const MEDIA_PATH = '/api/notify/media/';

/** Stores the image and returns its public link. */
export function shareImage(img: Image, publicUrl: string, now = Date.now()): string {
	const token = randomToken(32);
	const h = sqlite();
	h.prepare('DELETE FROM notify_media WHERE expires_at < ?').run(now);
	h.prepare('INSERT INTO notify_media (token_hash, data, type, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), img.data, img.type, now + TTL_MS);
	return `${trimSlash(publicUrl)}${MEDIA_PATH}${token}.${img.type === 'image/png' ? 'png' : 'jpg'}`;
}

export function sharedImage(tokenWithExt: string, now = Date.now()): Image | null {
	const token = tokenWithExt.replace(/\.(jpe?g|png)$/i, '');
	if (!/^[\w-]{43}$/.test(token)) return null;
	const row = sqlite().prepare('SELECT data, type, expires_at FROM notify_media WHERE token_hash = ?').get(sha256(token)) as { data: Uint8Array; type: string; expires_at: number } | undefined;
	if (!row || row.expires_at < now) return null;
	return { data: row.data, type: row.type };
}
