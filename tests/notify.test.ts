import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Everything external is mocked locally (ports 3206–3208 from this feature's range).
const HTTP_PORT = 3206;
const SMTP_PORT = 3207;
const SMTPS_PORT = 3208;
process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-notify-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-notify';
process.env.OCM_PUSHOVER_API = `http://127.0.0.1:${HTTP_PORT}/pushover/1/messages.json`;
const store = await import('../src/lib/server/store.ts');
const settings = await import('../src/lib/server/notify/settings.ts');
const service = await import('../src/lib/server/notify/service.ts');
const { render } = await import('../src/lib/server/notify/render.ts');
const { routeEvent, inQuietHours, Limiter } = await import('../src/lib/server/notify/routing.ts');
const { PrinterWatch, pauseReasonFrom } = await import('../src/lib/server/notify/watcher.ts');
const { ADAPTERS } = await import('../src/lib/server/notify/channels/index.ts');
const { webhookPayload } = await import('../src/lib/server/notify/channels/webhook.ts');
const { headerValue } = await import('../src/lib/server/notify/channels/ntfy.ts');
const { listDeliveries } = await import('../src/lib/server/notify/log.ts');
const { sharedImage } = await import('../src/lib/server/notify/media.ts');
const { endEvent } = await import('../src/lib/server/notify/bridge.ts');
const { startMockNotify, startMockSmtp } = await import('../scripts/e2e/mock-notify.mjs');
const { DEFAULT_QUIET, EVENT_KINDS } = await import('../src/lib/notify.ts');

type Mock = Awaited<ReturnType<typeof startMockNotify>>;
let http: Mock;
let smtp: Awaited<ReturnType<typeof startMockSmtp>>;
let smtps: Awaited<ReturnType<typeof startMockSmtp>>;
let M = '';

before(async () => {
	http = await startMockNotify(HTTP_PORT);
	smtp = await startMockSmtp(SMTP_PORT);
	smtps = await startMockSmtp(SMTPS_PORT, { secure: true });
	M = http.url;
});
after(async () => {
	await http.close();
	await smtp.close();
	await smtps.close();
});

const IMG = { data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]), type: 'image/jpeg' };
const record = {
	id: 9,
	printerId: 'p1',
	printerName: 'MK4',
	file: 'benchy.gcode',
	path: 'benchy.gcode',
	origin: 'local',
	startedAt: '2026-10-05T10:00:00Z',
	endedAt: '2026-10-05T11:00:00Z',
	durationS: 3600,
	result: 'failed' as const,
	reason: 'error',
	filamentMm: 1500,
	estimatedS: 3500,
	completion: 42.4,
	startedBy: 'Otto',
	octoprintUser: 'admin',
	source: 'live' as const,
	hasThumbnail: false,
	notes: null
};
const failedMsg = (extra: Partial<ReturnType<typeof render>> = {}) => ({ ...render(endEvent(record)!, { publicUrl: 'https://octo.example/', at: '2026-10-05T11:00:01Z' }), ...extra });

test('render: print end keeps the old wording; links, fields, generic kinds', () => {
	const m = failedMsg();
	assert.equal(m.title, 'Print failed: benchy.gcode');
	assert.equal(m.text, 'MK4: benchy.gcode failed after 1h 00m, at 42%, 1.50 m filament, reason: error, started by Otto.');
	assert.equal(m.url, 'https://octo.example/p/p1?tab=jobs');
	assert.equal(m.severity, 'error');
	assert.deepEqual(
		m.fields.map((f) => f.label),
		['Printer', 'File', 'Progress', 'Print time', 'Estimate', 'Filament', 'Started by', 'Reason']
	);
	const c = render(endEvent({ ...record, result: 'cancelled' }, 'Ada')!, { publicUrl: null });
	assert.match(c.text, /cancelled after 1h 00m, at 42%, 1\.50 m filament, cancelled by Ada, started by Otto\./);
	assert.equal(c.url, null);
	// A kind another feature raises, rendered generically.
	const g = render({ kind: 'spool.low', printerId: 'p1', fields: [{ label: 'Spool', value: 'PLA black, 42 g left' }] }, { publicUrl: 'http://o.lan', printerName: 'MK4' });
	assert.equal(g.title, 'Spool low: MK4');
	assert.equal(g.severity, 'warning');
	assert.deepEqual(g.fields.at(-1), { label: 'Spool', value: 'PLA black, 42 g left' });
	assert.equal(g.url, 'http://o.lan/p/p1');
	for (const kind of EVENT_KINDS) assert.ok(render({ kind }, { publicUrl: null }).title, kind);
});

test('ntfy: JSON without a picture, an attachment PUT with one', async () => {
	http.clear();
	await ADAPTERS.ntfy.send({ config: { server: `${M}/ntfy`, topic: 'prints' }, secrets: { token: 'tk_1' }, message: failedMsg() });
	const [a] = http.find('/ntfy');
	assert.equal(a.path, '/ntfy');
	assert.equal(a.headers.authorization, 'Bearer tk_1');
	assert.deepEqual(a.json, { topic: 'prints', title: 'Print failed: benchy.gcode', message: failedMsg().text, priority: 4, tags: ['x', 'octo-modern'], click: 'https://octo.example/p/p1?tab=jobs' });
	await ADAPTERS.ntfy.send({ config: { server: `${M}/ntfy`, topic: 'prints' }, secrets: {}, message: failedMsg({ image: IMG, title: 'Druck · fertig' }) });
	const b = http.find('/ntfy')[1];
	assert.equal(b.method, 'PUT');
	assert.equal(b.path, '/ntfy/prints');
	assert.equal(b.headers['x-filename'], 'snapshot.jpg');
	assert.equal(b.headers['x-title'], headerValue('Druck · fertig'));
	assert.match(b.headers['x-title'], /^=\?UTF-8\?B\?/);
	assert.deepEqual([...b.raw], [...IMG.data]);
});

test('Discord: an embed; multipart with the picture attached', async () => {
	http.clear();
	await ADAPTERS.discord.send({ config: {}, secrets: { url: `${M}/discord/1/x` }, message: failedMsg() });
	const [a] = http.find('/discord');
	assert.equal(a.json.embeds[0].color, 0xef4444);
	assert.equal(a.json.embeds[0].footer.text, 'MK4');
	assert.ok(a.json.embeds[0].fields.some((f: { name: string }) => f.name === 'Filament'));
	await ADAPTERS.discord.send({ config: {}, secrets: { url: `${M}/discord/1/x` }, message: failedMsg({ image: IMG }) });
	const b = http.find('/discord')[1];
	assert.equal(b.files['files[0]'].name, 'snapshot.jpg');
	assert.equal(JSON.parse(b.form.payload_json).embeds[0].image.url, 'attachment://snapshot.jpg');
});

test('Slack: Block Kit with the picture by link and a button back', async () => {
	http.clear();
	await ADAPTERS.slack.send({ config: {}, secrets: { url: `${M}/slack/T/B/x` }, message: failedMsg({ image: IMG, imageUrl: 'https://octo.example/api/notify/media/abc.jpg' }) });
	const [a] = http.find('/slack');
	const types = a.json.blocks.map((b: { type: string }) => b.type);
	assert.deepEqual(types, ['header', 'section', 'section', 'image', 'actions', 'context']);
	assert.equal(a.json.blocks[3].image_url, 'https://octo.example/api/notify/media/abc.jpg');
	assert.equal(a.json.blocks[4].elements[0].url, 'https://octo.example/p/p1?tab=jobs');
	assert.match(a.json.text, /^Print failed/);
});

test('Telegram: sendPhoto with an HTML caption, sendMessage without a picture, its errors verbatim', async () => {
	http.clear();
	const config = { server: `${M}/telegram`, chatId: '-1001' };
	await ADAPTERS.telegram.send({ config, secrets: { botToken: '123:abc' }, message: failedMsg({ image: IMG }) });
	await ADAPTERS.telegram.send({ config, secrets: { botToken: '123:abc' }, message: failedMsg({ title: '<b>&' }) });
	const [photo, text] = http.find('/telegram');
	assert.equal(photo.path, '/telegram/bot123:abc/sendPhoto');
	assert.equal(photo.form.chat_id, '-1001');
	assert.equal(photo.form.parse_mode, 'HTML');
	assert.equal(photo.files.photo.type, 'image/jpeg');
	assert.match(photo.form.caption, /^<b>Print failed: benchy\.gcode<\/b>/);
	assert.equal(text.path, '/telegram/bot123:abc/sendMessage');
	assert.match(text.json.text, /^<b>&lt;b&gt;&amp;<\/b>/);
	await assert.rejects(ADAPTERS.telegram.send({ config, secrets: { botToken: '000:bad' }, message: failedMsg() }), { message: 'HTTP 401: Unauthorized' });
	await assert.rejects(ADAPTERS.telegram.send({ config: { ...config, chatId: '-404' }, secrets: { botToken: '123:abc' }, message: failedMsg() }), { message: 'HTTP 400: Bad Request: chat not found' });
});

test('Pushover: multipart with the attachment, high priority for errors; its error list', async () => {
	http.clear();
	const secrets = { appToken: 'a'.repeat(30), userKey: 'k'.repeat(30) };
	await ADAPTERS.pushover.send({ config: { sound: 'magic' }, secrets, message: failedMsg({ image: IMG }) });
	const [a] = http.find('/pushover');
	assert.equal(a.form.priority, '1');
	assert.equal(a.form.sound, 'magic');
	assert.equal(a.form.url, 'https://octo.example/p/p1?tab=jobs');
	assert.equal(a.files.attachment.size, IMG.data.length);
	await assert.rejects(ADAPTERS.pushover.send({ config: {}, secrets: { ...secrets, userKey: 'u'.repeat(30) }, message: failedMsg() }), /HTTP 400: user identifier is not a valid/);
});

test('Gotify, Matrix, Home Assistant, webhook', async () => {
	http.clear();
	const m = failedMsg({ image: IMG, imageUrl: 'https://octo.example/api/notify/media/x.jpg' });
	await ADAPTERS.gotify.send({ config: { server: `${M}/gotify` }, secrets: { appToken: 'gt' }, message: m });
	const [g] = http.find('/gotify');
	assert.equal(g.headers['x-gotify-key'], 'gt');
	assert.equal(g.json.priority, 8);
	assert.match(g.json.message, /!\[snapshot\]\(https:\/\/octo\.example\/api\/notify\/media\/x\.jpg\)/);
	assert.equal(g.json.extras['client::notification'].click.url, m.url);

	await ADAPTERS.matrix.send({ config: { homeserver: `${M}/matrix`, roomId: '!room:mock' }, secrets: { accessToken: 'mx' }, message: m });
	const mx = http.find('/matrix');
	assert.equal(mx.length, 3, 'text, upload, image');
	assert.match(mx[0].path, /^\/matrix\/_matrix\/client\/v3\/rooms\/!room%3Amock\/send\/m\.room\.message\//);
	assert.equal(mx[0].json.format, 'org.matrix.custom.html');
	assert.equal(mx[1].headers['content-type'], 'image/jpeg');
	assert.equal(mx[2].json.msgtype, 'm.image');
	assert.match(mx[2].json.url, /^mxc:\/\/mock\//);
	await assert.rejects(ADAPTERS.matrix.send({ config: { homeserver: `${M}/matrix`, roomId: '!room:mock' }, secrets: { accessToken: 'bad' }, message: m }), {
		message: 'HTTP 401: M_UNKNOWN_TOKEN: Invalid access token passed.'
	});

	await ADAPTERS.homeassistant.send({ config: { baseUrl: `${M}/ha`, service: 'notify.mobile_app_pixel' }, secrets: { webhookId: 'hook-1', token: 'llt' }, message: m });
	const ha = http.find('/ha');
	const hook = ha.find((r) => r.path === '/ha/api/webhook/hook-1')!;
	const svc = ha.find((r) => r.path === '/ha/api/services/notify/mobile_app_pixel')!;
	assert.equal(hook.json.event, 'print.failed');
	assert.equal(svc.headers.authorization, 'Bearer llt');
	assert.equal(svc.json.data.image, m.imageUrl);
	assert.equal(svc.json.data.clickAction, m.url);
	await assert.rejects(ADAPTERS.homeassistant.send({ config: { baseUrl: `${M}/ha/fail401` }, secrets: { webhookId: 'w' }, message: m }), { message: 'webhook: HTTP 401: Invalid token (mock)' });

	await ADAPTERS.webhook.send({ config: { format: '1' }, secrets: { url: `${M}/hook/a`, authorization: 'Bearer s' }, message: m });
	await ADAPTERS.webhook.send({ config: { includeImage: 'true' }, secrets: { url: `${M}/hook/b` }, message: m });
	const [v1, v2] = http.find('/hook');
	assert.equal(v1.headers.authorization, 'Bearer s');
	assert.deepEqual(v1.json, JSON.parse(JSON.stringify(webhookPayload(m, '1'))));
	assert.equal(v1.json.event, 'failed', 'version 1 keeps the old event names');
	assert.equal(v1.json.print.completion, 42.4);
	assert.equal(v2.json.version, 2);
	assert.equal(v2.json.event, 'print.failed');
	assert.equal(Buffer.from(v2.json.image.base64, 'base64').length, IMG.data.length);
});

test('email over STARTTLS and TLS with the picture inline; SMTP errors verbatim', async () => {
	const config = { host: '127.0.0.1', port: String(SMTP_PORT), security: 'starttls', username: 'octo', from: 'octo@example.com', to: 'a@example.com, b@example.com', allowSelfSigned: 'true' };
	await ADAPTERS.email.send({ config, secrets: { password: 'secret' }, message: failedMsg({ image: IMG }) });
	const [mail] = smtp.messages;
	assert.equal(mail.secure, true, 'upgraded with STARTTLS');
	assert.equal(mail.user, 'octo');
	assert.deepEqual(mail.to, ['a@example.com', 'b@example.com']);
	assert.match(mail.raw, /Subject: Print failed: benchy\.gcode/);
	assert.match(mail.raw, /Content-ID: <snapshot@octo-modern>/);
	assert.match(mail.raw, /cid:snapshot@octo-modern/);
	await ADAPTERS.email.send({ config: { ...config, port: String(SMTPS_PORT), security: 'tls' }, secrets: { password: 'secret' }, message: failedMsg() });
	assert.equal(smtps.messages.length, 1);
	await assert.rejects(ADAPTERS.email.send({ config, secrets: { password: 'nope' }, message: failedMsg() }), /535 Authentication credentials invalid \(mock\)/);
	// The self-signed certificate is refused unless allowed.
	await assert.rejects(ADAPTERS.email.send({ config: { ...config, allowSelfSigned: '' }, secrets: { password: 'secret' }, message: failedMsg() }), /certificate/i);
});

test('HTTP failures carry the exact answer: status and body, refused connections, redirects', async () => {
	await assert.rejects(ADAPTERS.discord.send({ config: {}, secrets: { url: `${M}/discord/fail500` }, message: failedMsg() }), { message: 'HTTP 500: Internal error (mock)' });
	await assert.rejects(ADAPTERS.slack.send({ config: {}, secrets: { url: 'http://127.0.0.1:3209/nothing-listens' }, message: failedMsg() }), { message: 'ECONNREFUSED 127.0.0.1:3209' });
});

test('settings: the first version’s channels migrate with their sealed secrets and outcomes', () => {
	const { encrypt } = { encrypt: (v: string, ctx: string) => settings.seal(ctx.slice('notify:'.length), JSON.parse(v)) };
	store.setKv('history:notifications', {
		publicUrl: 'http://octo.lan',
		channels: [
			{ id: 'c-ntfy', kind: 'ntfy', name: 'Phone', enabled: true, on: ['success', 'failed'], config: { server: `${M}/ntfy`, topic: 'prints' }, sealed: encrypt(JSON.stringify({ token: 'tk_old' }), 'notify:c-ntfy'), lastError: null, lastSentAt: null },
			{ id: 'c-hook', kind: 'webhook', name: 'HA', enabled: false, on: ['cancelled'], config: {}, sealed: encrypt(JSON.stringify({ url: `${M}/hook/legacy` }), 'notify:c-hook'), lastError: 'x', lastSentAt: null }
		]
	});
	const s = settings.load();
	assert.equal(store.getKv('history:notifications', null), null, 'old entry removed');
	assert.equal(s.publicUrl, 'http://octo.lan');
	assert.deepEqual(
		s.channels.map((c) => [c.id, c.type, c.enabled, c.config.format ?? null]),
		[
			['c-ntfy', 'ntfy', true, null],
			['c-hook', 'webhook', false, '1']
		]
	);
	assert.deepEqual(settings.secretsOf(s.channels[0]), { token: 'tk_old' });
	assert.deepEqual(
		s.rules.map((r) => [r.printers, r.events, r.channels]),
		[
			['all', ['print.finished', 'print.failed'], ['c-ntfy']],
			['all', ['print.cancelled'], ['c-hook']]
		]
	);
	assert.deepEqual(settings.listChannels()[1].secrets, { url: '127.0.0.1:3206/…' });
	settings.save({ ...s, channels: [], rules: [] });
});

test('settings: validation, sealed secrets, kept when left empty, cleared on request', () => {
	assert.throws(() => settings.createChannel({ type: 'ntfy', name: 'phone' }), /Topic is required/);
	assert.throws(() => settings.createChannel({ type: 'telegram', secrets: { botToken: 'nope' }, config: { chatId: '1' } }), /bot token/);
	assert.throws(() => settings.createChannel({ type: 'matrix', config: { homeserver: 'https://m.org', roomId: '#alias:m.org' }, secrets: { accessToken: 'x' } }), /room ID/);
	assert.throws(() => settings.createChannel({ type: 'email', config: { host: 'smtp.x', from: 'a@x', to: 'nope' } }), /“To”/);
	assert.throws(() => settings.createChannel({ type: 'homeassistant', config: { baseUrl: 'http://ha', service: 'phone' } }), /token/);
	assert.throws(() => settings.createChannel({ type: 'sms' }), /channel type/);
	assert.throws(() => settings.createChannel({ type: 'slack', secrets: { url: 'https://hooks.slack.com/x' }, quiet: { enabled: true, start: '25:00', end: '07:00' } }), /start/);
	const c = settings.createChannel({ type: 'slack', name: 'Ops', secrets: { url: 'https://hooks.slack.com/services/SECRET-PART' } });
	assert.equal(c.secrets.url, 'hooks.slack.com/…');
	assert.ok(!JSON.stringify(store.getKv('notify:settings', null)).includes('SECRET-PART'), 'sealed at rest');
	const again = settings.updateChannel(c.id, { name: 'Ops 2', secrets: { url: '' }, quiet: { enabled: true, start: '22:00', end: '06:30', days: [5, 6, 9] } })!;
	assert.equal(again.secrets.url, 'hooks.slack.com/…', 'empty keeps the stored secret');
	assert.deepEqual(again.quiet.days, [5, 6]);
	const t = settings.createChannel({ type: 'webhook', secrets: { url: 'https://x.example/h', authorization: 'Bearer 1' } });
	assert.deepEqual(Object.keys(settings.updateChannel(t.id, { clear: ['authorization'] })!.secrets), ['url']);
	const s = settings.saveSettings({ rules: [{ name: 'All', events: ['print.failed', 'nope'], channels: [c.id, 'gone'], printers: 'all' }], progressPercents: '50, 25, 25', hot: { minutes: 5, bedC: 45 } });
	assert.deepEqual(s.rules[0].events, ['print.failed']);
	assert.deepEqual(s.rules[0].channels, [c.id]);
	assert.deepEqual(s.progressPercents, [25, 50]);
	assert.deepEqual(s.hot, { minutes: 5, bedC: 45, hotendC: 50 });
	assert.throws(() => settings.saveSettings({ progressPercents: [150] }), /1 to 99/);
	assert.throws(() => settings.saveSettings({ publicUrl: 'octo.lan' }), /public URL/);
	settings.deleteChannel(c.id);
	assert.deepEqual(settings.load().rules[0].channels, [], 'removed from rules');
	settings.deleteChannel(t.id);
});

test('routing: rules by printer and event; quiet hours across midnight and by day; de-dupe and rate limit', () => {
	const rules = [
		{ id: 'r1', name: 'a', enabled: true, printers: 'all' as const, events: ['print.failed' as const], channels: ['c1', 'c2'] },
		{ id: 'r2', name: 'b', enabled: true, printers: ['p2'], events: ['print.failed' as const, 'print.finished' as const], channels: ['c2', 'c3'] },
		{ id: 'r3', name: 'c', enabled: false, printers: 'all' as const, events: ['print.finished' as const], channels: ['c4'] }
	];
	assert.deepEqual(routeEvent(rules, 'print.failed', 'p1'), ['c1', 'c2']);
	assert.deepEqual(routeEvent(rules, 'print.failed', 'p2'), ['c1', 'c2', 'c3']);
	assert.deepEqual(routeEvent(rules, 'print.finished', 'p1'), []);
	assert.deepEqual(routeEvent(rules, 'print.finished', null), []);

	const q = { ...DEFAULT_QUIET, enabled: true, start: '22:00', end: '07:00' };
	const at = (d: string) => new Date(d);
	assert.equal(inQuietHours(q, at('2026-10-09T23:30:00')), true);
	assert.equal(inQuietHours(q, at('2026-10-10T06:59:00')), true);
	assert.equal(inQuietHours(q, at('2026-10-10T07:00:00')), false);
	assert.equal(inQuietHours(q, at('2026-10-10T12:00:00')), false);
	// Fridays only (5): Friday 23:00 and Saturday 06:00 are quiet, Saturday 23:00 isn't.
	const fri = { ...q, days: [5] };
	assert.equal(inQuietHours(fri, at('2026-10-09T23:00:00')), true);
	assert.equal(inQuietHours(fri, at('2026-10-10T06:00:00')), true);
	assert.equal(inQuietHours(fri, at('2026-10-10T23:00:00')), false);
	assert.equal(inQuietHours({ ...q, start: '09:00', end: '17:00' }, at('2026-10-10T12:00:00')), true);
	assert.equal(inQuietHours({ ...q, enabled: false }, at('2026-10-09T23:30:00')), false);

	const l = new Limiter();
	const o = { dedupeMs: 60_000, max: 3 };
	assert.equal(l.check('c', 'k1', o, 0), 'ok');
	assert.equal(l.check('c', 'k1', o, 30_000), 'deduped');
	assert.equal(l.check('other', 'k1', o, 30_000), 'ok', 'per channel');
	assert.equal(l.check('c', 'k1', o, 61_000), 'ok');
	assert.equal(l.check('c', 'k2', o, 62_000), 'ok');
	assert.equal(l.check('c', 'k3', o, 63_000), 'rate_limited');
	assert.equal(l.check('c', 'k3', o, 10 * 60_000 + 1), 'ok', 'the window moves on');
});

test('watcher: progress milestones, offline after the grace period, error, back, hot after a print', () => {
	const cfg = { progressPercents: [25, 50, 75], progressMinutesLeft: [10], offlineGraceS: 60, hot: { minutes: 15, bedC: 40, hotendC: 50 } };
	const w = new PrinterWatch();
	const job = { file: { path: 'a/benchy.gcode', name: 'benchy.gcode', display: 'benchy.gcode' }, estimatedPrintTime: 3600 };
	const snap = (state: string, completion: number | null = null, left: number | null = null, temps = {}) =>
		({ state, job, progress: { completion, printTime: 100, printTimeLeft: left }, temps }) as Parameters<typeof w.observe>[0];
	assert.deepEqual(w.observe(snap('operational'), 0, cfg), []);
	assert.deepEqual(w.observe(snap('printing', 1, 3500), 1, cfg), [], 'first sight of the print');
	assert.deepEqual(w.observe(snap('printing', 20, 2800), 2, cfg), []);
	const p = w.observe(snap('printing', 55, 1600), 3, cfg);
	assert.equal(p.length, 1, 'crossing 25 and 50 at once sends one');
	assert.equal(p[0].title, '50% done: benchy.gcode');
	assert.equal(p[0].print?.remainingS, 1600);
	assert.deepEqual(w.observe(snap('printing', 56, 1500), 4, cfg), []);
	const m = w.observe(snap('printing', 90, 500), 5, cfg);
	assert.deepEqual(m.map((e) => e.title), ['75% done: benchy.gcode', '10 min left: benchy.gcode']);
	w.observe(snap('operational', 100, 0, { bed: { actual: 60, target: 0 }, tool0: { actual: 120, target: 0 } }), 6, cfg);
	w.printEnded(6, cfg);
	assert.deepEqual(w.tick(6 + 14 * 60_000, cfg), []);
	const hot = w.tick(6 + 15 * 60_000, cfg);
	assert.equal(hot[0].kind, 'printer.hot');
	assert.equal(hot[0].message, 'Still hot 15 min after the print: bed 60 °C, hotend 120 °C.');
	assert.deepEqual(w.tick(6 + 16 * 60_000, cfg), [], 'once');

	// Offline: only after the grace period, back only after a notification.
	assert.deepEqual(w.observe({ state: 'offline', problem: { message: 'Connection refused' } }, 1_000_000, cfg), []);
	assert.deepEqual(w.observe({ state: 'operational' }, 1_030_000, cfg), [], 'a blip: nothing');
	w.observe({ state: 'offline', problem: { message: 'Connection refused' } }, 1_100_000, cfg);
	const off = w.tick(1_160_000, cfg);
	assert.equal(off[0].kind, 'printer.offline');
	assert.match(off[0].message!, /^Connection refused \(for 1 min\)\.$/);
	assert.deepEqual(w.tick(1_200_000, cfg), [], 'once');
	assert.deepEqual(w.observe({ state: 'operational' }, 1_300_000, cfg).map((e) => e.kind), ['printer.online']);
	assert.deepEqual(w.observe({ state: 'error', printerError: 'Thermal runaway' }, 1_400_000, cfg).map((e) => [e.kind, e.message]), [['printer.error', 'Printer error: Thermal runaway']]);
	assert.deepEqual(w.observe({ state: 'operational' }, 1_500_000, cfg).map((e) => e.kind), ['printer.online']);

	// Already down when first seen (e.g. after a restart): no notification.
	const fresh = new PrinterWatch();
	fresh.observe({ state: 'offline' }, 0, cfg);
	assert.deepEqual(fresh.tick(10 * 60_000, cfg), []);
});

test('watcher: why a print paused', () => {
	assert.equal(pauseReasonFrom(['Send: N120 G1 X10*33', 'Send: N121 M600*22'], []), 'filament change (M600)');
	assert.equal(pauseReasonFrom([], [{ name: 'FilamentChange', payload: { cmd: 'M600' } }]), 'filament change (M600)');
	assert.equal(pauseReasonFrom(['Recv: echo:Filament Runout detected'], []), 'filament runout');
	assert.equal(pauseReasonFrom([], [{ name: 'plugin:filamentsensorsimplified', payload: { type: 'runout' } }]), 'filament runout');
	assert.equal(pauseReasonFrom(['Send: M0 Change color'], []), 'pause in the G-code (M0)');
	assert.equal(pauseReasonFrom(['Recv: //action:pause'], []), 'paused by the printer');
	assert.equal(pauseReasonFrom(['Pausing print job due to command M0'], []), 'pause in the G-code (M0)');
	assert.equal(pauseReasonFrom(['Info: Not sending M0 to printer as it\'s configured as a blocked command'], []), 'pause in the G-code (M0)');
	assert.equal(pauseReasonFrom([], [{ name: 'CommandSuppressed', payload: { command: 'M0 Change color', severity: 'warn' } }]), 'pause in the G-code (M0)');
	assert.equal(pauseReasonFrom(['Send: G1 X1', 'Recv: ok'], []), null);
	const w = new PrinterWatch();
	w.log(['Send: N5 M600*1'], 0);
	assert.equal(w.pauseReason(1_000), 'filament change (M600)');
	assert.equal(w.pauseReason(2_000), null, 'what explained a pause doesn’t explain the next');
	w.log(['Send: N9 M600*1'], 3_000);
	assert.equal(w.pauseReason(200_000), null, 'only recent lines count');
	w.event('PrintCancelled', { user: 'octouser' }, 300_000);
	assert.equal(w.eventUser(['PrintCancelled'], 301_000), 'octouser');
});

test('notify(): routes, quiet hours (errors pass), de-dupe, snapshot attached and shared by link, delivery log', async () => {
	http.clear();
	service.limiter.reset();
	const printer = store.createPrinter({ name: 'Voron', baseUrl: 'http://127.0.0.1:9', apiKey: 'k-voron-123', verifyTls: true, webcamUrl: null, color: 'violet' });
	service.deps.snapshot = async () => IMG;
	const ntfy = settings.createChannel({ type: 'ntfy', name: 'Phone', config: { server: `${M}/ntfy`, topic: 'prints' } });
	const slack = settings.createChannel({ type: 'slack', name: 'Slack', secrets: { url: `${M}/slack/x` }, quiet: { enabled: true, start: '00:00', end: '23:59', allowCritical: true } });
	const broken = settings.createChannel({ type: 'discord', name: 'Broken', secrets: { url: `${M}/discord/fail401` } });
	settings.saveSettings({
		publicUrl: 'https://octo.example',
		mediaLinks: true,
		rules: [{ name: 'All', printers: 'all', events: ['print.finished', 'print.failed', 'spool.low'], channels: [ntfy.id, slack.id, broken.id] }]
	});
	service.deps.now = () => new Date('2026-10-10T12:00:00');
	const fin = await service.notify({ kind: 'print.finished', printerId: printer.id, print: { id: 1, file: 'cube.gcode', elapsedS: 60 } });
	assert.deepEqual(
		fin.map((o) => [o.channelName, o.status]).sort(),
		[
			['Broken', 'failed'],
			['Phone', 'sent'],
			['Slack', 'quiet']
		]
	);
	assert.equal(fin.find((o) => o.status === 'failed')!.error, 'HTTP 401: Invalid token (mock)');
	const put = http.find('/ntfy/prints')[0];
	assert.equal(put.method, 'PUT', 'the snapshot went as an attachment');
	assert.equal(put.headers['x-click'], `https://octo.example/p/${printer.id}?tab=jobs`);
	// A failure passes the quiet hours; the snapshot reaches Slack by link.
	const failed = await service.notify({ kind: 'print.failed', printerId: printer.id, print: { id: 1, file: 'cube.gcode' } });
	assert.equal(failed.find((o) => o.channelName === 'Slack')!.status, 'sent');
	const block = http.find('/slack')[0].json.blocks.find((b: { type: string }) => b.type === 'image');
	const token = block.image_url.split('/api/notify/media/')[1];
	assert.deepEqual([...sharedImage(token)!.data], [...IMG.data]);
	assert.equal(sharedImage('x'.repeat(43)), null);
	// The same event again is a duplicate.
	const dup = await service.notify({ kind: 'print.finished', printerId: printer.id, print: { id: 1, file: 'cube.gcode' } });
	assert.deepEqual(dup.map((o) => o.status).sort(), ['deduped', 'deduped', 'quiet']);
	// Not routed: nothing.
	assert.deepEqual(await service.notify({ kind: 'printer.hot', printerId: printer.id }), []);
	// A kind for other features, no printer.
	const spool = await service.notify({ kind: 'spool.low', title: 'Spool low: PLA black', message: '42 g left', snapshot: false });
	assert.equal(spool.find((o) => o.channelName === 'Phone')!.status, 'sent');
	assert.equal(http.find('/ntfy').at(-1)!.json.title, 'Spool low: PLA black');

	const log = listDeliveries(100);
	assert.equal(log[0].kind, 'spool.low');
	assert.ok(log.some((d) => d.status === 'quiet' && d.channelName === 'Slack'));
	assert.ok(log.some((d) => d.status === 'failed' && d.error === 'HTTP 401: Invalid token (mock)'));
	assert.ok(log.some((d) => d.status === 'sent' && d.image));
	const stored = settings.listChannels().find((c) => c.id === broken.id)!;
	assert.equal(stored.lastError, 'HTTP 401: Invalid token (mock)');

	// "Send test": a stored channel, and a draft that borrows the stored secrets.
	await assert.rejects(service.testChannel(broken.id), { message: 'HTTP 401: Invalid token (mock)' });
	const ok = await service.testChannel(broken.id, { type: 'discord', name: 'Fixed', secrets: { url: `${M}/discord/ok` } });
	assert.equal(ok.image, true);
	const r = await service.testChannel(ntfy.id, { type: 'ntfy', name: 'Phone', config: { server: `${M}/ntfy`, topic: 'other' } });
	assert.ok(r.ms >= 0);
	assert.equal(http.find('/ntfy/other')[0].headers['x-filename'], 'snapshot.jpg', 'tests send a picture too');
	for (const c of [ntfy, slack, broken]) settings.deleteChannel(c.id);
});
