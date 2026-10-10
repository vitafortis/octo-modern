import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupFilename, decodeBackup, encodeBackup, parseEnvelope, WRONG_PASSPHRASE } from '../src/lib/server/backup.ts';

const FAST = { N: 1024, r: 8, p: 1, appVersion: '1.2.3' };
const PASS = 'a long enough passphrase';

test('roundtrip: encode then decode returns the payload', async () => {
	const payload = { printers: [{ id: 'p1', apiKey: 'pw' }], n: 1 };
	const env = await encodeBackup(payload, PASS, FAST);
	assert.equal(env.format, 'octo-modern-backup');
	assert.equal(env.version, 1);
	assert.equal(env.cipher, 'aes-256-gcm');
	assert.equal(env.kdf.name, 'scrypt');
	assert.equal(env.appVersion, '1.2.3');
	assert.ok(!JSON.stringify(env).includes('"pw"'), 'payload is not in the clear');
	const { payload: back } = await decodeBackup(JSON.stringify(env), PASS);
	assert.deepEqual(back, payload);
});

test('short passphrases are refused', async () => {
	await assert.rejects(encodeBackup({}, 'short', FAST), /at least 12/);
});

test('wrong passphrase is a clear error', async () => {
	const env = await encodeBackup({ a: 1 }, PASS, FAST);
	await assert.rejects(decodeBackup(env, 'not the passphrase'), { message: WRONG_PASSPHRASE });
});

test('tampered ciphertext, tag or header fails', async () => {
	const env = await encodeBackup({ a: 'some data to flip' }, PASS, FAST);
	const data = Buffer.from(env.data, 'base64');
	data[0] ^= 1;
	await assert.rejects(decodeBackup({ ...env, data: data.toString('base64') }, PASS), { message: WRONG_PASSPHRASE });
	const tag = Buffer.from(env.tag, 'base64');
	tag[3] ^= 1;
	await assert.rejects(decodeBackup({ ...env, tag: tag.toString('base64') }, PASS), { message: WRONG_PASSPHRASE });
	await assert.rejects(decodeBackup({ ...env, createdAt: '2000-01-01T00:00:00.000Z' }, PASS), { message: WRONG_PASSPHRASE });
});

test('non-backups and absurd scrypt costs are rejected before decrypting', () => {
	assert.throws(() => parseEnvelope('{"hello":1}'), /Not an octo·modern backup/);
	assert.throws(() => parseEnvelope('nope'), /Not an octo·modern backup/);
	assert.throws(
		() => parseEnvelope({ format: 'octo-modern-backup', version: 1, createdAt: '', appVersion: '', cipher: 'aes-256-gcm', iv: '', tag: '', data: '', kdf: { name: 'scrypt', N: 1 << 20, r: 32, p: 1, salt: '' } }),
		/Damaged/
	);
});

test('filename is dated', () => {
	assert.equal(backupFilename(new Date('2026-10-08T12:00:00Z')), 'octo-modern-backup-2026-10-08.ocmbackup');
});

test('store export restores on a fresh install with a different master key', () => {
	const helper = join(import.meta.dirname, 'helpers', 'backup-store.ts');
	const file = join(mkdtempSync(join(tmpdir(), 'ocm-backup-file-')), 'b.ocmbackup');
	const run = (role: string, key: string) =>
		execFileSync(process.execPath, ['--no-warnings', '--experimental-strip-types', helper, role, mkdtempSync(join(tmpdir(), `ocm-backup-${role}-`)), key, file], {
			encoding: 'utf8'
		});
	run('export', 'master-key-one');
	const out = JSON.parse(run('import', 'master-key-two'));

	assert.deepEqual(out.preview.printers.map((p: { status: string }) => p.status), ['new', 'new']);
	assert.equal(out.preview.users.find((u: { email: string }) => u.email === 'admin@x.io').status, 'self');
	assert.match(out.zeroAdminError, /no enabled admin/);
	assert.equal(out.afterRollback, 0, 'failed restore is rolled back');

	// API keys were re-sealed with the new install's key.
	assert.deepEqual(out.keys, { mk4: 'app-key-mk4', ender: null });
	assert.deepEqual(out.result.printers, { added: 2, updated: 0 });
	assert.deepEqual(out.result.users, { added: 2, updated: 0, skipped: 1 });
	assert.equal(out.ender.verifyTls, false);
	assert.equal(out.ender.webcamUrl, '/webcam/?action=stream');

	// The signed-in admin is untouched even though the backup says disabled viewer.
	assert.deepEqual(out.me, { role: 'admin', disabled: false, keepsPassword: true });
	assert.equal(out.operator.role, 'operator');
	assert.equal(out.operator.printerAccess, 'selected');
	assert.equal(out.operatorGrants.length, 1);
	assert.equal(out.sso.clientSecret, 'sso-secret-value');
	assert.equal(out.sso.defaultRole, 'operator');
	assert.equal(out.localLogin, true);
});
