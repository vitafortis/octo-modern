/**
 * Browser push in the browser: what this device supports, and turning notifications on
 * and off for it. The service worker (src/service-worker/) shows them.
 */
import { api } from './api.ts';
import type { PushDevice, PushState } from '#lib/push.ts';

export type Support =
	| { ok: true }
	/** `ios-home`: iOS/iPadOS only offers push to home-screen apps. */
	| { ok: false; reason: 'insecure' | 'ios-home' | 'unsupported' };

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function support(): Support {
	if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
	const has = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
	if (isIos() && !standalone()) return { ok: false, reason: 'ios-home' };
	return has ? { ok: true } : { ok: false, reason: 'unsupported' };
}

export const pushApi = {
	state: () => api.get<PushState>('/api/push'),
	subscribe: (subscription: PushSubscriptionJSON) => api.post<{ device: PushDevice; state: PushState }>('/api/push/subscriptions', { subscription }),
	remove: (id: string) => api.del<{ ok: true; state: PushState }>(`/api/push/subscriptions/${encodeURIComponent(id)}`),
	test: (id: string) => api.post<{ ok: true; ms: number }>(`/api/push/subscriptions/${encodeURIComponent(id)}/test`)
};

function b64u(buf: ArrayBuffer | null | undefined): string {
	if (!buf) return '';
	let s = '';
	for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function keyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
	const s = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
	// SvelteKit registers the service worker; wait for it (but not forever).
	const ready = navigator.serviceWorker.ready;
	const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The service worker didn’t start; reload the page and try again')), 10_000));
	return Promise.race([ready, timeout]);
}

/** This browser's current subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
	if (support().ok !== true) return null;
	const reg = await navigator.serviceWorker.getRegistration();
	return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Asks for permission, subscribes with the server's key and registers the device. */
export async function enable(publicKey: string): Promise<{ device: PushDevice; state: PushState }> {
	const permission = await Notification.requestPermission();
	if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.' : 'Notifications weren’t allowed');
	const reg = await registration();
	let sub = await reg.pushManager.getSubscription();
	// Made for another key (the server's VAPID keys changed): start over.
	if (sub && b64u(sub.options.applicationServerKey) !== publicKey) {
		await sub.unsubscribe();
		sub = null;
	}
	sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
	return pushApi.subscribe(sub.toJSON());
}

/**
 * Keeps this device's subscription in step with the server: re-registers it when the
 * server's key changed (and notifications are still allowed). Returns the endpoint, if any.
 */
export async function sync(state: PushState): Promise<{ endpoint: string | null; state: PushState }> {
	const sub = await currentSubscription().catch(() => null);
	if (!sub) return { endpoint: null, state };
	if (b64u(sub.options.applicationServerKey) !== state.publicKey && Notification.permission === 'granted') {
		try {
			const r = await enable(state.publicKey);
			return { endpoint: r.device.endpoint, state: r.state };
		} catch {
			return { endpoint: null, state };
		}
	}
	return { endpoint: sub.endpoint, state };
}

/** Turns notifications off here: unsubscribes the browser and forgets the device. */
export async function disable(device: PushDevice | undefined): Promise<PushState | null> {
	const sub = await currentSubscription().catch(() => null);
	await sub?.unsubscribe().catch(() => {});
	return device ? (await pushApi.remove(device.id)).state : null;
}
