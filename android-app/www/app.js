// The app's own pages: first-launch setup, app settings, and "can't reach the server".
// Native side: OctoModernPlugin (android/app/src/main/java/…/OctoModernPlugin.kt).
(function () {
	'use strict';
	const $ = (id) => document.getElementById(id);
	const native = (method, args) => {
		const C = window.Capacitor;
		if (!C) return Promise.reject(new Error('Not running in the app'));
		return C.nativePromise('OctoModern', method, args || {});
	};

	function show(view) {
		for (const id of ['setup', 'settings', 'offline']) $(id).hidden = id !== view;
	}

	function route() {
		const hash = location.hash.slice(1);
		const [view, query] = hash.split('?');
		const params = new URLSearchParams(query || '');
		if (view === 'settings') return settings();
		if (view === 'offline') return offline(params);
		return setup();
	}

	function busy(btn, on, label) {
		btn.disabled = on;
		const span = btn.querySelector('span');
		if (span && label) span.textContent = label;
		const icon = btn.querySelector('svg use');
		if (icon) {
			if (on) {
				icon.dataset.was = icon.getAttribute('href');
				icon.setAttribute('href', '#i-loader');
				icon.parentElement.classList.add('spin');
			} else if (icon.dataset.was) {
				icon.setAttribute('href', icon.dataset.was);
				icon.parentElement.classList.remove('spin');
			}
		}
	}

	function note(el, text) {
		el.hidden = !text;
		if (text) el.querySelector('span').textContent = text;
	}

	// --- setup ---------------------------------------------------------------------------

	let checked = null;

	async function setup() {
		show('setup');
		try {
			const s = await native('getState');
			if (s.server && !$('server').value) $('server').value = s.server;
		} catch {}
		setTimeout(() => $('server').focus(), 50);
	}

	$('server').addEventListener('input', () => {
		checked = null;
		note($('setup-error'), '');
		$('setup-warning').hidden = true;
		$('connect').querySelector('span').textContent = 'Connect';
	});

	$('setup-form').addEventListener('submit', async (e) => {
		e.preventDefault();
		const btn = $('connect');
		// Second press after the http warning: go ahead.
		if (checked && checked.insecure) return connect(checked.origin);
		note($('setup-error'), '');
		busy(btn, true, 'Checking…');
		try {
			const r = await native('checkServer', { url: $('server').value });
			if (!r.ok) {
				note($('setup-error'), r.message);
				if (r.suggestion) {
					$('server').value = r.suggestion;
					note($('setup-error'), `${r.message} Press Connect to use ${r.suggestion}.`);
				}
				return;
			}
			checked = r;
			$('server').value = r.origin;
			if (r.insecure) {
				$('setup-warning').hidden = false;
				return;
			}
			await connect(r.origin);
		} catch (err) {
			note($('setup-error'), err.message || String(err));
		} finally {
			busy(btn, false, checked && checked.insecure ? 'Continue with http' : 'Connect');
		}
	});

	async function connect(origin) {
		busy($('connect'), true, 'Opening…');
		await native('connect', { origin });
	}

	// --- settings ------------------------------------------------------------------------

	let state = null;

	function setSwitch(el, on, disabled) {
		el.setAttribute('aria-checked', on ? 'true' : 'false');
		el.disabled = !!disabled;
	}

	function renderSettings() {
		const s = state;
		$('s-server').textContent = s.server || 'Not set';
		const acct = $('s-account');
		acct.textContent = '';
		if (s.account) {
			acct.append(`${s.account.name || s.account.email} `);
			const b = document.createElement('span');
			b.className = 'badge badge-primary';
			b.textContent = s.account.role;
			acct.append(b);
		} else if (s.linked) {
			acct.textContent = s.accountError ? 'Signed in (server unreachable)' : 'Signed in';
		} else {
			acct.textContent = 'Not signed in yet';
			acct.className = 'muted';
		}
		$('sign-out').hidden = !s.linked;
		setSwitch($('t-notifications'), s.notifications);
		setSwitch($('t-keep'), s.keepWatching, !s.notifications);
		$('perm-note').hidden = !s.notifications || s.notificationsAllowed;
		$('battery-row').hidden = !s.notifications || !s.keepWatching || s.batteryExempt || s.android < 31;
		setSwitch($('t-lock'), s.biometricLock, !s.biometricAvailable && !s.biometricLock);
		$('lock-desc').textContent = s.biometricAvailable
			? 'Asks when you come back to the app after a while.'
			: 'Set up a screen lock or fingerprint on this phone to use this.';
		$('lock-after-row').hidden = !s.biometricLock;
		$('lock-after').value = String(s.lockAfterMinutes);
		$('s-version').textContent = s.version;
		$('s-linked').innerHTML = s.linked ? '<span class="badge badge-success">Linked</span>' : '<span class="badge">Not linked</span>';
	}

	async function settings() {
		show('settings');
		try {
			state = await native('getState');
			renderSettings();
		} catch (err) {
			note($('settings-error'), err.message || String(err));
		}
	}

	async function save(patch) {
		note($('settings-error'), '');
		try {
			await native('saveSettings', patch);
			Object.assign(state, patch);
		} catch (err) {
			note($('settings-error'), err.message || String(err));
		}
		renderSettings();
	}

	$('t-notifications').addEventListener('click', async () => {
		const on = !state.notifications;
		await save({ notifications: on });
		if (on && !state.notificationsAllowed) $('allow-notifications').click();
	});
	$('t-keep').addEventListener('click', () => save({ keepWatching: !state.keepWatching }));
	$('t-lock').addEventListener('click', () => save({ biometricLock: !state.biometricLock }));
	$('lock-after').addEventListener('change', (e) => save({ lockAfterMinutes: Number(e.target.value) }));
	$('allow-notifications').addEventListener('click', async () => {
		const r = await native('requestNotifications').catch(() => ({ allowed: false }));
		state.notificationsAllowed = r.allowed;
		renderSettings();
	});
	$('battery').addEventListener('click', () => native('requestBatteryExemption'));
	// Coming back from the system settings: refresh what changed there.
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden && !$('settings').hidden) settings();
	});
	$('back').addEventListener('click', () => native('openServer', {}));
	$('sign-out').addEventListener('click', async (e) => {
		if (!confirm('Sign out of octo·modern on this phone? Notifications and widgets stop until you sign in again.')) return;
		busy(e.currentTarget, true);
		await native('signOut');
	});
	$('change-server').addEventListener('click', async () => {
		if (!confirm('Sign out and connect to a different server?')) return;
		await native('forgetServer');
	});

	// --- offline -------------------------------------------------------------------------

	function offline(params) {
		show('offline');
		const url = params.get('url') || '';
		const err = params.get('error') || '';
		$('offline-detail').textContent = `${url ? new URL(url).origin : 'The server'} didn’t answer${err ? ` (${err.replace(/^net::/, '')})` : ''}. Check that this phone is on the right network or VPN.`;
	}
	$('retry').addEventListener('click', () => native('openServer', {}));
	$('offline-settings').addEventListener('click', () => {
		location.hash = 'settings';
	});

	window.addEventListener('hashchange', route);
	route();
})();
