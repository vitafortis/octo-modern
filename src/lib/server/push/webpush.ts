/**
 * Web Push, hand-rolled on node:crypto (no dependency): message encryption (RFC 8291,
 * `aes128gcm` content coding from RFC 8188) and VAPID authentication (RFC 8292, an ES256
 * JWT). Every current browser accepts `aes128gcm`, so the legacy `aesgcm` coding isn't
 * implemented. Pure apart from `sendPush`, which makes one HTTP request.
 */
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

export const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string) => Buffer.from(s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url');

/** A subscription as the browser's `PushSubscription.toJSON()` gives it. */
export interface Subscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
	/** Uncompressed P-256 point (65 bytes), base64url: what the browser's `applicationServerKey` takes. */
	publicKey: string;
	/** The private scalar (32 bytes), base64url. Same formats as the `web-push` tool's keys. */
	privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
	const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const pub = publicKey.export({ format: 'jwk' });
	const priv = privateKey.export({ format: 'jwk' });
	return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x!), fromB64u(pub.y!)])), privateKey: priv.d! };
}

/** Throws unless the pair is a well-formed P-256 key pair that belongs together. */
export function checkVapidKeys(k: VapidKeys): void {
	const pub = fromB64u(k.publicKey);
	if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key: expected an uncompressed P-256 point (65 bytes, base64url)');
	const d = fromB64u(k.privateKey);
	if (d.length !== 32) throw new Error('VAPID private key: expected 32 bytes, base64url');
	const ecdh = createECDH('prime256v1');
	ecdh.setPrivateKey(d);
	if (!ecdh.getPublicKey().equals(pub)) throw new Error('The VAPID public key does not belong to the private key');
}

function vapidKeyObject(k: VapidKeys): KeyObject {
	const pub = fromB64u(k.publicKey);
	return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: k.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}

/** The `Authorization` header for a push service: `vapid t=<ES256 JWT>, k=<public key>`. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now(), ttlS = 12 * 3600): string {
	const aud = new URL(endpoint).origin;
	const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + ttlS, sub: subject })));
	const input = `${header}.${claims}`;
	// JOSE wants the raw r||s signature, not DER.
	const sig = sign('sha256', Buffer.from(input), { key: vapidKeyObject(keys), dsaEncoding: 'ieee-p1363' });
	return `vapid t=${input}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** Record size; one record carries the whole message (push services take at most 4 KB anyway). */
const RS = 4096;
/** Push services must accept at least 4096 bytes of body: 86 of header and tag leave 4010, minus the delimiter. */
export const MAX_PLAINTEXT = 3993;

/**
 * Encrypts `plaintext` for a subscription (RFC 8291 §3.4). `salt` and `localKey` (the
 * sender's ephemeral private key) are random unless given, for the RFC's test vector.
 */
export function encrypt(plaintext: Uint8Array, sub: Subscription['keys'], opts: { salt?: Uint8Array; localKey?: Uint8Array } = {}): Buffer {
	if (plaintext.length > MAX_PLAINTEXT) throw new Error(`Push message too large (${plaintext.length} bytes)`);
	const uaPublic = fromB64u(sub.p256dh);
	const authSecret = fromB64u(sub.auth);
	if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Subscription key p256dh is not a P-256 point');
	if (authSecret.length < 16) throw new Error('Subscription auth secret is too short');
	const salt = Buffer.from(opts.salt ?? randomBytes(16));
	const ecdh = createECDH('prime256v1');
	if (opts.localKey) ecdh.setPrivateKey(Buffer.from(opts.localKey));
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const shared = ecdh.computeSecret(uaPublic);
	const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
	const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
	const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
	const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
	const cipher = createCipheriv('aes-128-gcm', cek, nonce);
	// 0x02: the last (only) record, no padding after it.
	const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const header = Buffer.alloc(21);
	salt.copy(header, 0);
	header.writeUInt32BE(RS, 16);
	header.writeUInt8(asPublic.length, 20);
	return Buffer.concat([header, asPublic, body]);
}

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';

export interface PushRequest {
	url: string;
	headers: Record<string, string>;
	body: Buffer;
}

/** The HTTP request that delivers `payload` to one subscription (RFC 8030). */
export function buildRequest(sub: Subscription, payload: string, o: { vapid: VapidKeys; subject: string; ttlS?: number; urgency?: Urgency; topic?: string; now?: number }): PushRequest {
	const headers: Record<string, string> = {
		authorization: vapidAuthorization(sub.endpoint, o.vapid, o.subject, o.now),
		ttl: String(Math.max(0, Math.round(o.ttlS ?? 24 * 3600))),
		urgency: o.urgency ?? 'normal',
		'content-encoding': 'aes128gcm',
		'content-type': 'application/octet-stream'
	};
	if (o.topic) headers.topic = o.topic;
	return { url: sub.endpoint, headers, body: encrypt(Buffer.from(payload, 'utf8'), sub.keys) };
}

export class PushError extends Error {
	status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = 'PushError';
		this.status = status;
	}
	/** The push service says the subscription is no more (unsubscribed, expired): forget it. */
	get gone() {
		return this.status === 404 || this.status === 410;
	}
}

export const PUSH_TIMEOUT_MS = 15_000;

/** Sends one push message; throws a PushError with the push service's answer. */
export async function sendPush(req: PushRequest): Promise<{ status: number }> {
	let res: Response;
	try {
		res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body as Uint8Array<ArrayBuffer>, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS), redirect: 'manual' });
	} catch (err) {
		const e = err as Error & { cause?: { code?: string; address?: string; port?: number } };
		if (e.name === 'TimeoutError') throw new PushError(`No answer within ${PUSH_TIMEOUT_MS / 1000} s`);
		const c = e.cause;
		throw new PushError(c?.code ? `${c.code}${c.address ? ` ${c.address}${c.port ? `:${c.port}` : ''}` : ''}` : e.message);
	}
	const text = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
	if (res.status < 200 || res.status >= 300) throw new PushError(`HTTP ${res.status}${text ? `: ${text}` : ''}`, res.status);
	return { status: res.status };
}
