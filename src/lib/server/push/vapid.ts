/**
 * The VAPID key pair that identifies this octo·modern to the browsers' push services.
 * VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY override it; otherwise a pair is generated on first
 * use and kept in kv (`push:vapid`), the private key sealed with the master key. Changing
 * the pair invalidates every subscription (browsers bind them to the public key), so the
 * devices re-subscribe the next time someone opens octo·modern on them.
 */
import { decrypt, encrypt } from '../crypto.ts';
import { getKv, setKv, sqlite } from '../store.ts';
import { checkVapidKeys, generateVapidKeys, type VapidKeys } from './webpush.ts';

export const VAPID_KV = 'push:vapid';
const CONTEXT = 'push:vapid';

interface StoredVapid {
	publicKey: string;
	/** The private key, sealed with the context `push:vapid`. */
	sealed: string;
	createdAt: string;
}

let cached: { keys: VapidKeys; source: 'env' | 'stored' } | null = null;

/** Forgets the cached pair (tests, restore). */
export function resetVapidCache() {
	cached = null;
}

function fromEnv(): VapidKeys | null {
	const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
	const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
	if (!publicKey && !privateKey) return null;
	if (!publicKey || !privateKey) throw new Error('Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (or neither)');
	const keys = { publicKey, privateKey };
	checkVapidKeys(keys);
	return keys;
}

/** The pair in use: from the environment, else the stored one, else a new stored one. */
export function vapidKeys(): VapidKeys & { source: 'env' | 'stored' } {
	if (cached) return { ...cached.keys, source: cached.source };
	const env = fromEnv();
	if (env) {
		cached = { keys: env, source: 'env' };
		return { ...env, source: 'env' };
	}
	const stored = getKv<StoredVapid | null>(VAPID_KV, null);
	if (stored) {
		const keys = { publicKey: stored.publicKey, privateKey: decrypt(stored.sealed, CONTEXT) };
		cached = { keys, source: 'stored' };
		return { ...keys, source: 'stored' };
	}
	const keys = generateVapidKeys();
	setKv(VAPID_KV, { publicKey: keys.publicKey, sealed: encrypt(keys.privateKey, CONTEXT), createdAt: new Date().toISOString() } satisfies StoredVapid);
	console.log('[octo-modern] browser push: generated a VAPID key pair');
	cached = { keys, source: 'stored' };
	return { ...keys, source: 'stored' };
}

/**
 * The `sub` claim: who to contact about this sender. VAPID_SUBJECT, else the public
 * https address, else the first admin's email. Apple rejects `localhost` subjects.
 */
export function vapidSubject(publicUrl: string | null): string {
	const env = process.env.VAPID_SUBJECT?.trim();
	if (env) return env;
	if (publicUrl && /^https:\/\//i.test(publicUrl) && !/^https:\/\/(localhost|127\.)/i.test(publicUrl)) return publicUrl.replace(/\/+$/, '');
	const admin = sqlite().prepare(`SELECT email FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY created_at LIMIT 1`).get() as { email?: string } | undefined;
	if (admin?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin.email)) return `mailto:${admin.email}`;
	return 'mailto:octo-modern@example.com';
}
