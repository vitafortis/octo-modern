/**
 * octo·modern's service worker.
 *
 * - Caches the app shell: the hashed JS/CSS SvelteKit builds and the files in static/
 *   (icons, manifest, the offline page), per version, cache-first. Nothing else.
 * - Never caches pages, API responses, camera streams, live updates (SSE) or sign-in:
 *   those always go to the network. Pages hold per-person data, so only when the
 *   server can't be reached does a navigation get the offline page instead.
 * - Shows Web Push notifications and opens (or focuses) the printer page on click.
 */
import { self as sw } from '$app/service-worker';
import { immutable, assets } from '$app/manifest';
import { version } from '$app/env';
import type { PushPayload } from '#lib/push.ts';

const CACHE = `ocm-shell-${version}`;
const OFFLINE = '/offline.html';
// Font subsets other than Latin load only when a page needs them: not worth precaching.
const SHELL = [...immutable.map((f) => f.path), ...assets.map((f) => f.path)]
	.filter((p) => !p.endsWith('.woff2') || p.includes('-latin-'))
	.map((p) => (p.startsWith('/') ? p : `/${p}`));
const CACHED = new Set(SHELL);

/** Paths a navigation never gets the offline page for (APIs, sign-in, the slicer API, downloads). */
const BYPASS = /^\/(api|auth|octoprint|login|setup)(\/|$)/;

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(SHELL.includes(OFFLINE) ? SHELL : [...SHELL, OFFLINE]);
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) if (key.startsWith('ocm-shell-') && key !== CACHE) await caches.delete(key);
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== sw.location.origin) return;

	// The app shell: from the cache (filled at install), else the network.
	if (CACHED.has(url.pathname) && !url.search) {
		event.respondWith(
			(async () => {
				const hit = await caches.match(req, { cacheName: CACHE });
				return hit ?? fetch(req);
			})()
		);
		return;
	}

	// Pages: always the network; the offline page only when it can't be reached.
	if (req.mode === 'navigate' && !BYPASS.test(url.pathname)) {
		event.respondWith(
			(async () => {
				try {
					return await fetch(req);
				} catch {
					const offline = await caches.match(OFFLINE, { cacheName: CACHE });
					return offline ?? new Response('octo·modern is offline', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
				}
			})()
		);
	}
	// Everything else (APIs, SSE, webcam streams, thumbnails…) isn't touched.
});

// --- push ------------------------------------------------------------------------

function parse(data: PushMessageData | null): Partial<PushPayload> {
	if (!data) return {};
	try {
		return data.json() as Partial<PushPayload>;
	} catch {
		return { body: data.text() };
	}
}

sw.addEventListener('push', (event) => {
	const p = parse(event.data);
	const at = p.at ? Date.parse(p.at) : NaN;
	const options: NotificationOptions & { renotify?: boolean; image?: string; timestamp?: number } = {
		body: p.body ?? '',
		icon: '/icon-192.png',
		badge: '/badge-96.png',
		tag: p.tag,
		// A newer message about the same print still alerts.
		renotify: !!p.tag,
		requireInteraction: p.severity === 'error',
		data: { url: p.url ?? '/' }
	};
	if (p.image) options.image = p.image;
	if (Number.isFinite(at)) options.timestamp = at;
	event.waitUntil(sw.registration.showNotification(p.title || 'octo·modern', options));
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	let target = new URL('/', sw.location.origin);
	try {
		const u = new URL((event.notification.data as { url?: string } | null)?.url ?? '/', sw.location.origin);
		if (u.origin === sw.location.origin) target = u;
	} catch {}
	event.waitUntil(
		(async () => {
			const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const exact = wins.find((c) => c.url === target.href);
			if (exact) return void (await exact.focus());
			const open = wins.find((c) => new URL(c.url).origin === sw.location.origin);
			if (open) {
				try {
					const focused = await open.focus();
					if (await focused.navigate(target.href)) return;
				} catch {}
			}
			await sw.clients.openWindow(target.href);
		})()
	);
});

// The push service renewed or dropped the subscription: subscribe again and tell the server.
sw.addEventListener('pushsubscriptionchange', (event) => {
	const e = event as ExtendableEvent & { oldSubscription?: PushSubscription | null; newSubscription?: PushSubscription | null };
	e.waitUntil(
		(async () => {
			let sub = e.newSubscription ?? null;
			if (!sub) {
				const res = await fetch('/api/push', { credentials: 'same-origin' });
				if (!res.ok) return;
				const { publicKey } = (await res.json()) as { publicKey: string };
				sub = await sw.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
			}
			await fetch('/api/push/subscriptions', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ subscription: sub.toJSON() })
			});
		})().catch(() => {})
	);
});
