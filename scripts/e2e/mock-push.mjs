// A stand-in Web Push service (what FCM, Mozilla's autopush or Apple's push service do for
// real), for the browser push tests and `pnpm e2e:push`. Nothing real is contacted.
//
// `newSubscription(name)` makes a subscription like a browser's `PushSubscription.toJSON()`:
// an endpoint here, plus a fresh P-256 key pair and auth secret whose private half the mock
// keeps. Each POST to an endpoint is checked like a push service would (VAPID JWT signed by
// the `k` key, audience = this origin, not expired, aes128gcm body) and decrypted (RFC 8291),
// so tests see exactly what the service worker would get.
//
// Endpoints named `gone…` answer 410 Gone, `missing…` 404, `fail…` 500, others 201.
import { createServer } from 'node:http';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

/** Decrypts an aes128gcm Web Push body with the receiver's keys (RFC 8291 §3.4, receiver side). */
export function decryptPush(body, { privateKey, publicKey, auth }) {
	const salt = body.subarray(0, 16);
	const rs = body.readUInt32BE(16);
	const idlen = body[20];
	const asPublic = body.subarray(21, 21 + idlen);
	const ciphertext = body.subarray(21 + idlen);
	if (ciphertext.length > rs) throw new Error('more than one record');
	const ecdh = createECDH('prime256v1');
	ecdh.setPrivateKey(privateKey);
	const shared = ecdh.computeSecret(asPublic);
	const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), publicKey, asPublic]);
	const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
	const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
	const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
	const d = createDecipheriv('aes-128-gcm', cek, nonce);
	d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
	const plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
	// Strip the padding: the last non-zero byte is the delimiter (2 = last record).
	let end = plain.length - 1;
	while (end >= 0 && plain[end] === 0) end--;
	if (plain[end] !== 2) throw new Error(`bad padding delimiter ${plain[end]}`);
	return plain.subarray(0, end).toString('utf8');
}

/** Checks a `vapid t=…, k=…` header; returns the JWT claims and key, or throws. */
export function checkVapid(authorization, origin, now = Date.now()) {
	const m = /^vapid t=([^,\s]+),\s*k=([-_A-Za-z0-9]+)$/.exec(authorization ?? '');
	if (!m) throw new Error('no VAPID authorization');
	const [h, c, s] = m[1].split('.');
	const k = fromB64u(m[2]);
	const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(k.subarray(1, 33)), y: b64u(k.subarray(33, 65)) }, format: 'jwk' });
	if (!verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(s))) throw new Error('bad VAPID signature');
	const header = JSON.parse(fromB64u(h).toString());
	if (header.alg !== 'ES256') throw new Error('VAPID alg must be ES256');
	const claims = JSON.parse(fromB64u(c).toString());
	if (claims.aud !== origin) throw new Error(`VAPID aud ${claims.aud} is not ${origin}`);
	if (!(claims.exp * 1000 > now && claims.exp * 1000 <= now + 24 * 3600_000 + 60_000)) throw new Error('VAPID exp out of range');
	if (!/^(mailto:|https:)/.test(claims.sub ?? '')) throw new Error('VAPID sub must be mailto: or https:');
	return { claims, publicKey: m[2] };
}

export async function startMockPush(port = 0, host = '127.0.0.1') {
	const subs = new Map();
	const received = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on('data', (d) => chunks.push(d));
		req.on('end', () => {
			const name = decodeURIComponent((req.url ?? '').replace(/^\/push\//, ''));
			const sub = subs.get(name);
			const entry = { name, at: Date.now(), headers: req.headers, payload: null, error: null, vapid: null };
			received.push(entry);
			try {
				if (req.method !== 'POST' || !sub) throw Object.assign(new Error('no such subscription'), { status: 404 });
				entry.vapid = checkVapid(req.headers.authorization, origin);
				if (req.headers['content-encoding'] !== 'aes128gcm') throw new Error('content-encoding must be aes128gcm');
				if (!req.headers.ttl) throw new Error('TTL header missing');
				const body = Buffer.concat(chunks);
				if (body.length > 4096) throw Object.assign(new Error('payload too large'), { status: 413 });
				entry.payload = JSON.parse(decryptPush(body, sub));
			} catch (err) {
				entry.error = err.message;
				res.writeHead(err.status ?? 400, { 'content-type': 'text/plain' }).end(err.message);
				return;
			}
			if (name.startsWith('gone')) return res.writeHead(410, { 'content-type': 'text/plain' }).end('push subscription has unsubscribed or expired.');
			if (name.startsWith('missing')) return res.writeHead(404).end('Not Found');
			if (name.startsWith('fail')) return res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal error (mock)');
			res.writeHead(201, { location: `${origin}/m/${received.length}` }).end();
		});
	});
	await new Promise((r) => server.listen(port, host, r));
	const origin = `http://${host}:${server.address().port}`;
	return {
		url: origin,
		received,
		/** A browser-like subscription whose endpoint is here. */
		newSubscription(name) {
			const ecdh = createECDH('prime256v1');
			ecdh.generateKeys();
			const auth = randomBytes(16);
			subs.set(name, { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth });
			return { endpoint: `${origin}/push/${encodeURIComponent(name)}`, expirationTime: null, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
		},
		/** Payloads delivered to `name` (successfully decrypted), oldest first. */
		payloadsFor: (name) => received.filter((r) => r.name === name && r.payload).map((r) => r.payload),
		reset: () => (received.length = 0),
		close: () => (server.closeAllConnections(), new Promise((r) => server.close(r)))
	};
}
