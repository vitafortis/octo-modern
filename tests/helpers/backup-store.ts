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
const ALL = { printers: true, users: true, settings: true };

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
	writeFileSync(file, JSON.stringify(await encodeBackup(cb.snapshot(ALL), PASSPHRASE, FAST)));
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

	const result = cb.applyRestore(p, ALL, me.id);
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
			localLogin: store.getKv('local-login-disabled', null)
		})
	);
}
