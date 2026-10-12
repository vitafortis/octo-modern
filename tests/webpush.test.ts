import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH } from 'node:crypto';

// Browser push: encryption, VAPID, key storage, payloads, who gets what, and cleanup.
// The push service is a local mock (scripts/e2e/mock-push.mjs) on port 5210; nothing real is contacted.
const PUSH_PORT = 5210;
process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-webpush-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-webpush';
process.env.OCM_PUSH_ENDPOINTS = `http://127.0.0.1:${PUSH_PORT}/push/`;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.VAPID_SUBJECT;

const wp = await import('../src/lib/server/push/webpush.ts');
const vapid = await import('../src/lib/server/push/vapid.ts');
const subs = await import('../src/lib/server/push/subscriptions.ts');
const deliver = await import('../src/lib/server/push/deliver.ts');
const store = await import('../src/lib/server/store.ts');
const settings = await import('../src/lib/server/notify/settings.ts');
const service = await import('../src/lib/server/notify/service.ts');
const { render } = await import('../src/lib/server/notify/render.ts');
const { ADAPTERS } = await import('../src/lib/server/notify/channels/index.ts');
const { listDeliveries } = await import('../src/lib/server/notify/log.ts');
const { deviceLabel } = await import('../src/lib/push.ts');
const { startMockPush, decryptPush, checkVapid } = await import('../scripts/e2e/mock-push.mjs');

type Mock = Awaited<ReturnType<typeof startMockPush>>;
let mock: Mock;
before(async () => {
	mock = await startMockPush(PUSH_PORT);
});
after(async () => {
	await mock.close();
});

// --- encryption and VAPID ----------------------------------------------------------

test('aes128gcm encryption matches the RFC 8291 test vector', () => {
	const out = wp.encrypt(
		Buffer.from('When I grow up, I want to be a watermelon'),
		{ p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
		{ salt: wp.fromB64u('DGv6ra1nlYgDCS1FRnbzlw'), localKey: wp.fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') }
	);
	assert.equal(
		wp.b64u(out),
		'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
	);
});

test('encrypted messages decrypt on the receiving side; oversized ones are refused', () => {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	const auth = Buffer.alloc(16, 7);
	const keys = { p256dh: wp.b64u(ecdh.getPublicKey()), auth: wp.b64u(auth) };
	const text = JSON.stringify({ title: 'Druck fertig · ✓', body: 'x'.repeat(2000) });
	const body = wp.encrypt(Buffer.from(text), keys);
	assert.ok(body.length <= 4096);
	assert.equal(decryptPush(body, { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth }), text);
	// Every message gets its own salt and sender key.
	assert.notDeepEqual(wp.encrypt(Buffer.from('a'), keys).subarray(0, 16), wp.encrypt(Buffer.from('a'), keys).subarray(0, 16));
	assert.throws(() => wp.encrypt(Buffer.alloc(wp.MAX_PLAINTEXT + 1), keys), /too large/);
	assert.throws(() => wp.encrypt(Buffer.from('a'), { p256dh: 'AAAA', auth: keys.auth }), /p256dh/);
});

test('VAPID: an ES256 JWT for the push service origin, signed by the public key it names', () => {
	const keys = wp.generateVapidKeys();
	wp.checkVapidKeys(keys);
	assert.equal(wp.fromB64u(keys.publicKey).length, 65);
	assert.equal(wp.fromB64u(keys.privateKey).length, 32);
	const now = Date.now();
	const header = wp.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:me@example.com', now);
	const { claims, publicKey } = checkVapid(header, 'https://fcm.googleapis.com', now);
	assert.equal(publicKey, keys.publicKey);
	assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: Math.floor(now / 1000) + 12 * 3600, sub: 'mailto:me@example.com' });
	// Another key pair's signature doesn't verify.
	const other = wp.generateVapidKeys();
	const forged = header.replace(/k=.*$/, `k=${other.publicKey}`);
	assert.throws(() => checkVapid(forged, 'https://fcm.googleapis.com', now), /bad VAPID signature/);
	assert.throws(() => wp.checkVapidKeys({ publicKey: keys.publicKey, privateKey: other.privateKey }), /does not belong/);
});

// --- VAPID key storage ---------------------------------------------------------------

test('the VAPID pair is generated once, stored sealed, and env keys override it', () => {
	vapid.resetVapidCache();
	assert.equal(store.getKv(vapid.VAPID_KV, null), null);
	const first = vapid.vapidKeys();
	assert.equal(first.source, 'stored');
	const stored = store.getKv<{ publicKey: string; sealed: string }>(vapid.VAPID_KV, { publicKey: '', sealed: '' });
	assert.equal(stored.publicKey, first.publicKey);
	assert.ok(!JSON.stringify(stored).includes(first.privateKey), 'the private key is not stored in the clear');
	assert.match(stored.sealed, /^v1:/);
	vapid.resetVapidCache();
	const again = vapid.vapidKeys();
	assert.equal(again.publicKey, first.publicKey);
	assert.equal(again.privateKey, first.privateKey);

	const env = wp.generateVapidKeys();
	process.env.VAPID_PUBLIC_KEY = env.publicKey;
	process.env.VAPID_PRIVATE_KEY = env.privateKey;
	try {
		vapid.resetVapidCache();
		const fromEnv = vapid.vapidKeys();
		assert.equal(fromEnv.source, 'env');
		assert.equal(fromEnv.publicKey, env.publicKey);
		// The stored pair is left alone.
		assert.equal(store.getKv<{ publicKey: string }>(vapid.VAPID_KV, { publicKey: '' }).publicKey, first.publicKey);
		process.env.VAPID_PRIVATE_KEY = first.privateKey;
		vapid.resetVapidCache();
		assert.throws(() => vapid.vapidKeys(), /does not belong/);
		delete process.env.VAPID_PRIVATE_KEY;
		vapid.resetVapidCache();
		assert.throws(() => vapid.vapidKeys(), /Set both/);
	} finally {
		delete process.env.VAPID_PUBLIC_KEY;
		delete process.env.VAPID_PRIVATE_KEY;
		vapid.resetVapidCache();
	}
	assert.equal(vapid.vapidKeys().publicKey, first.publicKey);
});

test('VAPID subject: VAPID_SUBJECT, else the https address, else an admin’s email', () => {
	assert.equal(vapid.vapidSubject('https://octo.example.com/'), 'https://octo.example.com');
	assert.equal(vapid.vapidSubject('http://octo.lan:3040'), 'mailto:octo-modern@example.com');
	assert.equal(vapid.vapidSubject('https://localhost:3040'), 'mailto:octo-modern@example.com');
	process.env.VAPID_SUBJECT = 'mailto:ops@example.com';
	assert.equal(vapid.vapidSubject('https://octo.example.com'), 'mailto:ops@example.com');
	delete process.env.VAPID_SUBJECT;
});

// --- subscriptions -------------------------------------------------------------------

test('only https endpoints of browser push services (or OCM_PUSH_ENDPOINTS) are accepted', () => {
	const keys = mock.newSubscription('probe').keys;
	for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QO', 'https://wns2-par02p.notify.windows.com/w/?token=x', `${mock.url}/push/x`])
		assert.doesNotThrow(() => subs.parseSubscription({ endpoint: ok, keys }), ok);
	for (const bad of ['http://fcm.googleapis.com/fcm/send/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', `${mock.url}/other`, 'http://192.168.1.10/x', 'file:///etc/passwd'])
		assert.throws(() => subs.parseSubscription({ endpoint: bad, keys }), /isn’t one octo·modern sends to/, bad);
	assert.throws(() => subs.parseSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, p256dh: 'short' } }), /p256dh/);
	assert.throws(() => subs.parseSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: '' } }), /auth/);
	assert.throws(() => subs.parseSubscription(null), /no push endpoint/);
});

test('device names come from the user agent', () => {
	assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
	assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'), 'Chrome on Android');
	assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'), 'Firefox on macOS');
	assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'), 'Edge on Windows');
	assert.equal(deviceLabel(''), 'Browser');
});

// --- payloads ------------------------------------------------------------------------

const msg = (over: Partial<Parameters<typeof render>[0]> = {}, publicUrl: string | null = 'https://octo.example.com') =>
	render({ kind: 'print.finished', printerId: 'p-1', printerName: 'MK4', print: { file: 'benchy.gcode', elapsedS: 3600 }, ...over }, { publicUrl, at: '2026-10-11T10:00:00.000Z' });

test('payload: title, text, the printer page to open, a tag per printer and topic', () => {
	const p = deliver.buildPayload(msg());
	assert.equal(p.title, 'Print finished: benchy.gcode');
	assert.match(p.body, /^MK4: benchy\.gcode finished after 1h/);
	assert.equal(p.url, '/p/p-1?tab=jobs');
	assert.equal(p.tag, 'ocm:p-1:print');
	assert.equal(p.printerId, 'p-1');
	assert.equal(p.severity, 'success');
	assert.equal(p.image, undefined);
	// Without a public URL the path is built from the printer; links from other features are kept.
	assert.equal(deliver.buildPayload(msg({ kind: 'printer.offline' }, null)).url, '/p/p-1');
	assert.equal(deliver.buildPayload(msg({ kind: 'printer.offline' }, null)).tag, 'ocm:p-1:printer');
	assert.equal(deliver.buildPayload(msg({ kind: 'queue.bed_clear_needed', link: '/queue' })).url, '/queue');
	assert.equal(deliver.buildPayload(msg({ kind: 'spool.low', printerId: null })).url, '/');
	// Long text is cut so the encrypted message stays under 4 KB.
	const long = deliver.buildPayload(msg({ title: 'T'.repeat(500), message: 'ü'.repeat(3000) }));
	assert.equal(long.title.length, 120);
	assert.equal(long.body.length, 600);
	assert.ok(Buffer.byteLength(JSON.stringify(long)) < wp.MAX_PLAINTEXT);
	const m = msg();
	m.imageUrl = 'https://octo.example.com/api/notify/media/abc.jpg';
	assert.equal(deliver.buildPayload(m).image, m.imageUrl);
	// Push service hints.
	assert.deepEqual(deliver.deliveryOptions(msg({ kind: 'print.failed' })), { ttlS: 86400, urgency: 'high' });
	const prog = deliver.deliveryOptions(msg({ kind: 'print.progress' }));
	assert.equal(prog.urgency, 'low');
	assert.match(prog.topic!, /^[-_A-Za-z0-9]{1,32}$/);
});

// --- who gets what -------------------------------------------------------------------

const fixture = (() => {
	let made: ReturnType<typeof build> | null = null;
	function build() {
		const p1 = store.createPrinter({ name: 'MK4', baseUrl: 'http://127.0.0.1:5299', apiKey: undefined, verifyTls: true, webcamUrl: null, color: 'violet' });
		const p2 = store.createPrinter({ name: 'Voron', baseUrl: 'http://127.0.0.1:5298', apiKey: undefined, verifyTls: true, webcamUrl: null, color: 'cyan' });
		const admin = store.createUser({ email: 'admin@example.com', role: 'admin' });
		const operator = store.createUser({ email: 'op@example.com', role: 'operator' });
		const viewer = store.createUser({ email: 'viewer@example.com', role: 'viewer' });
		store.updateUser(viewer.id, { printerAccess: 'selected' });
		store.setGrants(viewer.id, [p1.id]);
		return { p1, p2, admin, operator, viewer };
	}
	return () => (made ??= build());
})();

function subscribe(userId: string, name: string, vapidKey = vapid.vapidKeys().publicKey) {
	return subs.saveSubscription(userId, subs.parseSubscription(mock.newSubscription(name)), { label: name, vapidKey });
}

function clearSubs() {
	for (const s of subs.listSubscriptions()) subs.deleteSubscription(s.id, null);
}

test('recipients: the audience, per-printer access, disabled and removed people, old keys', () => {
	const f = fixture();
	clearSubs();
	const a = subscribe(f.admin.id, 'admin-phone');
	const o = subscribe(f.operator.id, 'op-laptop');
	const v = subscribe(f.viewer.id, 'viewer-phone');
	const names = (r: { targets: { label: string }[] }) => r.targets.map((t) => t.label).sort();
	const on = (id: string) => ({ printer: { id, name: id } });

	assert.deepEqual(names(deliver.recipients(on(f.p1.id), 'all')), ['admin-phone', 'op-laptop', 'viewer-phone']);
	// The viewer has no access to the Voron.
	assert.deepEqual(names(deliver.recipients(on(f.p2.id), 'all')), ['admin-phone', 'op-laptop']);
	assert.deepEqual(names(deliver.recipients(on(f.p1.id), 'control')), ['admin-phone', 'op-laptop']);
	assert.deepEqual(names(deliver.recipients(on(f.p1.id), 'admin')), ['admin-phone']);
	// Printer-less events go to the whole audience.
	assert.deepEqual(names(deliver.recipients({ printer: null }, 'all')), ['admin-phone', 'op-laptop', 'viewer-phone']);
	assert.deepEqual(names(deliver.recipients({ printer: null }, 'all', { only: [v.id] })), ['viewer-phone']);

	// Disabled people get nothing but keep their devices.
	store.updateUser(f.operator.id, { disabled: true });
	assert.deepEqual(names(deliver.recipients(on(f.p1.id), 'all')), ['admin-phone', 'viewer-phone']);
	assert.ok(subs.getSubscription(o.id));
	store.updateUser(f.operator.id, { disabled: false });

	// A subscription for an old VAPID key, and one of a person who's gone, are forgotten.
	const stale = subscribe(f.admin.id, 'admin-old-key', wp.generateVapidKeys().publicKey);
	const ghost = subs.saveSubscription('no-such-user', subs.parseSubscription(mock.newSubscription('ghost')), { label: 'ghost', vapidKey: vapid.vapidKeys().publicKey });
	const r = deliver.recipients(on(f.p1.id), 'all');
	assert.equal(r.removed, 2);
	assert.equal(subs.getSubscription(stale.id), null);
	assert.equal(subs.getSubscription(ghost.id), null);
	assert.ok(subs.getSubscription(a.id));
	assert.deepEqual(subs.subscriptionCounts(), { devices: 3, users: 3 });
});

test('a device follows whoever subscribes it; people only remove their own; removing a person removes their devices', () => {
	const f = fixture();
	clearSubs();
	const sub = subs.parseSubscription(mock.newSubscription('shared-pc'));
	const first = subs.saveSubscription(f.operator.id, sub, { label: 'Chrome on Windows', vapidKey: vapid.vapidKeys().publicKey });
	const second = subs.saveSubscription(f.viewer.id, sub, { label: 'Chrome on Windows', vapidKey: vapid.vapidKeys().publicKey });
	assert.equal(second.id, first.id);
	assert.equal(second.userId, f.viewer.id);
	assert.equal(subs.listSubscriptions(f.operator.id).length, 0);
	assert.deepEqual(subs.getSubscription(first.id)!.keys, sub.keys);
	// The keys are sealed at rest.
	const row = store.sqlite().prepare('SELECT secret FROM push_subscriptions WHERE id = ?').get(first.id) as { secret: string };
	assert.ok(!row.secret.includes(sub.keys.auth));
	assert.equal(subs.deleteSubscription(first.id, f.operator.id), false);
	assert.ok(subs.getSubscription(first.id));
	const temp = store.createUser({ email: 'temp@example.com', role: 'viewer' });
	subscribe(temp.id, 'temp-phone');
	assert.equal(subs.listSubscriptions(temp.id).length, 1);
	store.deleteUser(temp.id);
	assert.equal(subs.listSubscriptions(temp.id).length, 0);
});

// --- delivery against the mock push service ------------------------------------------

test('delivery: encrypted, VAPID-signed, decrypted by the mock; 404/410 devices are removed', async () => {
	const f = fixture();
	clearSubs();
	mock.reset();
	const ok = subscribe(f.admin.id, 'ok-admin');
	const viewerOk = subscribe(f.viewer.id, 'ok-viewer');
	const gone = subscribe(f.operator.id, 'gone-operator');
	const missing = subscribe(f.operator.id, 'missing-operator');
	const failing = subscribe(f.admin.id, 'fail-admin');

	const r = await deliver.deliver(msg({ printerId: f.p2.id, printerName: 'Voron' }), 'all', { publicUrl: 'https://octo.example.com' });
	assert.deepEqual({ sent: r.sent, failed: r.failed, gone: r.gone, targets: r.targets }, { sent: 1, failed: 1, gone: 2, targets: 4 });
	assert.match(r.errors[0], /^fail-admin: HTTP 500: Internal error \(mock\)/);
	// The viewer can't see the Voron: nothing was sent to their device.
	assert.equal(mock.payloadsFor('ok-viewer').length, 0);
	const [p] = mock.payloadsFor('ok-admin');
	assert.equal(p.title, 'Print finished: benchy.gcode');
	assert.equal(p.url, `/p/${f.p2.id}?tab=jobs`);
	const req = mock.received.find((x: { name: string }) => x.name === 'ok-admin')!;
	assert.equal(req.error, null);
	assert.equal(req.vapid.claims.sub, 'https://octo.example.com');
	assert.equal(req.vapid.publicKey, vapid.vapidKeys().publicKey);
	assert.equal(req.headers.urgency, 'normal');
	assert.equal(req.headers.ttl, '86400');
	// Gone devices are forgotten; the failing one keeps its error, the good one its time.
	assert.equal(subs.getSubscription(gone.id), null);
	assert.equal(subs.getSubscription(missing.id), null);
	assert.match(subs.getSubscription(failing.id)!.lastError!, /HTTP 500/);
	assert.ok(subs.getSubscription(ok.id)!.lastSentAt);
	assert.ok(subs.getSubscription(viewerOk.id));
});

test('the Browser push channel through notify(): rules, access, delivery log', async () => {
	const f = fixture();
	clearSubs();
	mock.reset();
	service.limiter.reset();
	subscribe(f.admin.id, 'n-admin');
	subscribe(f.viewer.id, 'n-viewer');
	assert.equal(ADAPTERS.push.validate!({ audience: 'everyone' }, {}), 'Choose who gets the notifications');
	const ch = settings.createChannel({ type: 'push', name: 'Phones', config: { audience: 'all' } });
	assert.deepEqual(ch.config, { audience: 'all' });
	settings.saveSettings({ publicUrl: 'https://octo.example.com', rules: [{ name: 'All', printers: 'all', events: ['print.failed', 'printer.offline'], channels: [ch.id] }] });

	const out = await service.notify({ kind: 'print.failed', printerId: f.p1.id, print: { id: 41, file: 'cube.gcode' }, snapshot: false });
	assert.deepEqual(out.map((o) => o.status), ['sent']);
	assert.equal(mock.payloadsFor('n-admin')[0].title, 'Print failed: cube.gcode');
	assert.equal(mock.payloadsFor('n-viewer')[0].severity, 'error');
	assert.equal(mock.received.find((x: { name: string }) => x.name === 'n-admin')!.headers.urgency, 'high');

	// The Voron: only the admin's phone.
	await service.notify({ kind: 'printer.offline', printerId: f.p2.id, snapshot: false });
	assert.equal(mock.payloadsFor('n-admin').length, 2);
	assert.equal(mock.payloadsFor('n-viewer').length, 1);
	assert.equal(listDeliveries(5)[0].channelType, 'push');

	// "Send test" on the channel reaches everyone in the audience.
	await service.testChannel(ch.id);
	assert.equal(mock.payloadsFor('n-viewer').at(-1)!.title, 'Test from octo·modern');

	// Every device gone: the delivery fails with why, and the devices are forgotten.
	clearSubs();
	subscribe(f.admin.id, 'gone-1');
	service.limiter.reset();
	const gone = await service.notify({ kind: 'print.failed', printerId: f.p1.id, print: { id: 42, file: 'cube.gcode' }, snapshot: false });
	assert.equal(gone[0].status, 'failed');
	assert.match(gone[0].error!, /unsubscribed at the push service and removed/);
	assert.equal(subs.listSubscriptions().length, 0);
	service.limiter.reset();
	const none = await service.notify({ kind: 'print.failed', printerId: f.p1.id, print: { id: 43, file: 'cube.gcode' }, snapshot: false });
	assert.match(none[0].error!, /No device has browser notifications turned on/);
});
