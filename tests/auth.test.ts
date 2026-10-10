import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-auth-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-auth';
const { emailMatches } = await import('../src/lib/server/auth.ts');
const { hashPassword, verifyPassword, encrypt, decrypt } = await import('../src/lib/server/crypto.ts');
const store = await import('../src/lib/server/store.ts');

test('email patterns', () => {
	const patterns = ['*@example.com', 'bob@gmail.com', '@corp.io'];
	assert.ok(emailMatches('Alice@Example.com', patterns));
	assert.ok(emailMatches('bob@gmail.com', patterns));
	assert.ok(emailMatches('x@corp.io', patterns));
	assert.ok(!emailMatches('alice@example.com.evil.org', patterns));
	assert.ok(!emailMatches('eve@gmail.com', patterns));
	assert.ok(emailMatches('anyone@anywhere', ['*']));
	assert.ok(!emailMatches('anyone@anywhere', []));
});

test('passwords are scrypt-hashed and verified', () => {
	const h = hashPassword('hunter2-hunter2');
	assert.match(h, /^scrypt:/);
	assert.ok(verifyPassword('hunter2-hunter2', h));
	assert.ok(!verifyPassword('hunter3-hunter3', h));
});

test('secrets are bound to their context (AAD)', () => {
	const sealed = encrypt('api-key', 'printer:a');
	assert.equal(decrypt(sealed, 'printer:a'), 'api-key');
	assert.throws(() => decrypt(sealed, 'printer:b'));
});

test('sessions end when a user is disabled or their role changes', () => {
	const u = store.createUser({ email: 'op@x.io', role: 'operator' });
	store.createSession('hash-1', u.id, 60_000);
	assert.equal(store.sessionUser('hash-1')?.role, 'operator');
	store.updateUser(u.id, { role: 'viewer' });
	assert.equal(store.sessionUser('hash-1'), undefined);
	store.createSession('hash-2', u.id, 60_000);
	store.updateUser(u.id, { disabled: true });
	assert.equal(store.sessionUser('hash-2'), undefined);
	store.createSession('hash-3', u.id, -1);
	assert.equal(store.sessionUser('hash-3'), undefined, 'expired');
});
