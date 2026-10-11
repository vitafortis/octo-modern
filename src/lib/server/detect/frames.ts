/**
 * One-time frame links for the ML container.
 *
 * Obico's ML API only takes an image URL (see obico.ts), and it has no octo·modern
 * session. So for each frame octo·modern:
 *
 * 1. takes the snapshot itself (the same server-side webcam fetch the UI uses),
 * 2. keeps those bytes in memory under a fresh 256-bit random token,
 * 3. hands the ML API `<public URL>/api/detect/frame/<token>`.
 *
 * The link serves that one already-captured JPEG and nothing else: not the camera,
 * not another printer, not any other route (hooks.server.ts lets only this path
 * through without a session, and only for GET). It works once (the ML API fetches it
 * once; its own retries only follow failed attempts), expires after 30 seconds
 * either way, and is revoked as soon as the ML API has answered. Only a SHA-256 of
 * the token is kept, so lookups don't leak timing about stored tokens. Nothing
 * touches the disk.
 */
import { randomToken, sha256 } from '../crypto.ts';

export const FRAME_TTL_MS = 30_000;
const MAX_FRAMES = 64;
export const FRAME_PATH = '/api/detect/frame/';

interface Frame {
	printerId: string;
	bytes: Uint8Array;
	type: string;
	expires: number;
}

const G = globalThis as typeof globalThis & { __ocmDetectFrames?: Map<string, Frame> };
const frames: Map<string, Frame> = (G.__ocmDetectFrames ??= new Map());

function sweep(now: number) {
	for (const [k, f] of frames) if (f.expires <= now) frames.delete(k);
	// Oldest first (insertion order) if something keeps issuing without fetching.
	while (frames.size >= MAX_FRAMES) frames.delete(frames.keys().next().value!);
}

/** Stores a frame and returns its token (URL-safe base64, 43 characters). */
export function issueFrame(printerId: string, bytes: Uint8Array, type = 'image/jpeg', ttlMs = FRAME_TTL_MS, now = Date.now()): string {
	sweep(now);
	const token = randomToken(32);
	frames.set(sha256(token), { printerId, bytes, type, expires: now + ttlMs });
	return token;
}

/** The frame for a token, removing it: a second request gets nothing. */
export function takeFrame(token: string, now = Date.now()): Frame | null {
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
	const key = sha256(token);
	const f = frames.get(key);
	if (!f) return null;
	frames.delete(key);
	return f.expires > now ? f : null;
}

export function revokeFrame(token: string) {
	frames.delete(sha256(token));
}

/** Frames waiting to be fetched (tests, diagnostics). */
export const pendingFrames = () => frames.size;

/** The URL the ML container fetches. */
export function frameUrl(publicUrl: string, token: string): string {
	return `${publicUrl.replace(/\/+$/, '')}${FRAME_PATH}${token}`;
}
