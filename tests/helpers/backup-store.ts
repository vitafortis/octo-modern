// Runs one side of the store-level backup test in its own process, so each side
// gets its own data dir and master key (config and the key are read once per process).
// Usage: node --experimental-strip-types backup-store.ts <export|import> <dataDir> <secretKey> <file>
import { readFileSync, writeFileSync } from 'node:fs';

const [role, dataDir, secretKey, file] = process.argv.slice(2);
process.env.OCM_DATA_DIR = dataDir;
process.env.OCM_SECRET_KEY = secretKey;

const store = await import('../../src/lib/server/store.ts');
const { encodeBackup, decodeBackup } = await import('../../src/lib/server/backup.ts');
const cb = await import('../../src/lib/server/config-backup.ts');
const { saveSso, ssoConfig } = await import('../../src/lib/server/sso.ts');
const { hashPassword, verifyPassword } = await import('../../src/lib/server/crypto.ts');

const PASSPHRASE = 'correct horse battery staple';
const FAST = { N: 1024, r: 8, p: 1 };
const ALL = { printers: true, users: true, settings: true, notifications: true, history: true };
const notify = await import('../../src/lib/server/notify/settings.ts');
const hs = await import('../../src/lib/server/history/store.ts');

if (role === 'export') {
	const mk4 = store.createPrinter({ name: 'mk4', baseUrl: 'http://mk4.lan', apiKey: 'app-key-mk4', verifyTls: true, webcamUrl: null, color: 'violet' });
	store.createPrinter({ name: 'ender', baseUrl: 'https://ender.lan', verifyTls: false, webcamUrl: '/webcam/?action=stream', color: 'amber' });
	// In the backup, admin@x.io is a disabled viewer: restoring must not demote the signed-in admin.
	const admin = store.createUser({ email: 'admin@x.io', role: 'viewer', passwordHash: hashPassword('old-password') });
	store.updateUser(admin.id, { disabled: true });
	const op = store.createUser({ email: 'op@x.io', role: 'operator', passwordHash: hashPassword('op-password') });
	store.createUser({ email: 'owner@x.io', role: 'admin', passwordHash: hashPassword('owner-password') });
	store.updateUser(op.id, { printerAccess: 'selected' });
	store.setGrants(op.id, [mk4.id]);
	saveSso({ issuer: 'https://id.example', clientId: 'ocm', clientSecret: 'sso-secret-value', name: 'Pocket', scopes: 'openid email', autoCreate: [], adminEmails: [], defaultRole: 'operator' });
	store.setKv('local-login-disabled', true);
	// Notifications: a channel with secrets, quiet hours and a rule for one printer.
	const tg = notify.createChannel({ type: 'telegram', name: 'Team chat', config: { chatId: '-1001' }, secrets: { botToken: '123:telegram-secret' }, quiet: { enabled: true, start: '22:00', end: '07:00', allowCritical: true } });
	notify.saveSettings({ publicUrl: 'https://octo.example', progressPercents: [50], rules: [{ name: 'MK4 failures', printers: [mk4.id], events: ['print.failed'], channels: [tg.id] }] });
	// History: two entries (one with a picture, one started by the operator).
	const one = hs.insertPrint({ printerId: mk4.id, printerName: 'mk4', file: 'benchy.gcode', path: 'benchy.gcode', origin: 'local', startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T11:00:00.000Z', result: 'success', durationS: 3600, userId: op.id, startedBy: 'op' })!;
	hs.setThumbnail(one, new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]), 'image/jpeg');
	hs.insertPrint({ printerId: mk4.id, printerName: 'mk4', file: 'gear.gcode', path: 'parts/gear.gcode', origin: 'local', startedAt: '2026-10-02T10:00:00.000Z', result: 'printing', userId: op.id, startedBy: 'op' });
	const env = await encodeBackup(cb.snapshot(ALL, { historyImages: true }), PASSPHRASE, FAST);
	writeFileSync(file, JSON.stringify(env));
	const small = JSON.stringify(cb.snapshot({ ...ALL, history: true }, { historyImages: false })).includes('"thumbnail"');
	console.log(JSON.stringify({ ok: true, thumbnailsWithoutImages: small }));
	process.exit(0);
	console.log(JSON.stringify({ ok: true }));
} else {
	// A fresh install whose signed-in admin is admin@x.io with a different password.
	const me = store.createUser({ email: 'admin@x.io', role: 'admin', passwordHash: hashPassword('new-password') });
	const { payload } = await decodeBackup(readFileSync(file, 'utf8'), PASSPHRASE);
	const p = cb.validatePayload(payload);
	const preview = cb.previewRestore(p, me.id, { createdAt: '', appVersion: '' });

	let zeroAdminError = '';
	try {
		cb.applyRestore({ ...p, users: p.users!.map((u) => ({ ...u, disabled: true })) }, ALL, null);
	} catch (err) {
		zeroAdminError = (err as Error).message;
	}
	const afterRollback = store.listPrinters().length;

	// An entry already here is kept, not doubled.
	hs.insertPrint({ printerId: p.printers![0].id, printerName: 'mk4', file: 'benchy.gcode', path: 'benchy.gcode', origin: 'local', startedAt: '2026-10-01T10:00:00.000Z', result: 'success' });
	const result = cb.applyRestore(p, ALL, me.id);
	const again = cb.applyRestore(p, { ...cb.NO_CATEGORIES, history: true }, me.id);
	const ns = notify.load();
	const prints = hs.listPrints({ limit: 10 });
	const printers = store.listPrinters();
	const meAfter = store.getUser(me.id)!;
	const operator = store.findUserByEmail('op@x.io')!;
	console.log(
		JSON.stringify({
			preview,
			zeroAdminError,
			afterRollback,
			result,
			keys: Object.fromEntries(printers.map((x) => [x.name, store.getApiKey(x.id) ?? null])),
			ender: printers.find((x) => x.name === 'ender'),
			me: { role: meAfter.role, disabled: meAfter.disabled, keepsPassword: verifyPassword('new-password', store.getPasswordHash(me.id)!) },
			operator,
			operatorGrants: store.listGrants(operator.id),
			sso: ssoConfig(),
			localLogin: store.getKv('local-login-disabled', null),
			notify: {
				channels: ns.channels.map((c) => ({ name: c.name, type: c.type, config: c.config, quiet: c.quiet, secrets: notify.secretsOf(c) })),
				rules: ns.rules.map((r) => ({ name: r.name, printers: r.printers, events: r.events, channels: r.channels.map((id) => ns.channels.find((c) => c.id === id)?.name) })),
				publicUrl: ns.publicUrl,
				progressPercents: ns.progressPercents,
				mk4Id: printers.find((x) => x.name === 'mk4')!.id
			},
			history: {
				previewed: preview.history,
				result: result.history,
				again: again.history,
				rows: prints.map((r) => ({ file: r.file, result: r.result, reason: r.reason, startedBy: r.startedBy, hasThumbnail: r.hasThumbnail })),
				operatorOwns: prints.filter((r) => r.file === 'benchy.gcode' && r.startedBy === 'op').length,
				userIds: (store.sqlite().prepare('SELECT user_id FROM prints WHERE user_id IS NOT NULL').all() as { user_id: string }[]).map((r) => r.user_id)
			}
		})
	);
}
