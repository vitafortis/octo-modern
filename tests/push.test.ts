import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PushSession, type PushStatus } from '../src/lib/server/octoprint/push.ts';
import { backoffDelay } from '../src/lib/server/octoprint/backoff.ts';
import type { SocketLike } from '../src/lib/server/octoprint/transport.ts';

class FakeSocket implements SocketLike {
	readyState = 0;
	sent: unknown[] = [];
	closed = false;
	onopen: SocketLike['onopen'] = null;
	onmessage: SocketLike['onmessage'] = null;
	onclose: SocketLike['onclose'] = null;
	onerror: SocketLike['onerror'] = null;
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.closed = true;
	}
	open() {
		this.readyState = 1;
		this.onopen?.({});
	}
	receive(msg: unknown) {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}
}

/** Manual timers so reconnects and watchdogs run when the test says so. */
function clock() {
	let id = 0;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	return {
		set: (fn: () => void, ms: number) => (timers.set(++id, { fn, ms }), id),
		clear: (h: unknown) => void timers.delete(h as number),
		/** Runs the pending timer with the given delay (or the shortest). */
		fire(ms?: number) {
			const entries = [...timers.entries()].sort((a, b) => a[1].ms - b[1].ms);
			const hit = ms === undefined ? entries[0] : entries.find(([, t]) => t.ms === ms);
			if (!hit) throw new Error(`no timer ${ms ?? ''}; pending: ${entries.map(([, t]) => t.ms).join(', ')}`);
			timers.delete(hit[0]);
			hit[1].fn();
		},
		pending: () => [...timers.values()].map((t) => t.ms).sort((a, b) => a - b)
	};
}

const tick = () => new Promise((r) => setImmediate(r));

function setup(opts: { login?: () => Promise<{ name: string; session: string }> } = {}) {
	const c = clock();
	const sockets: FakeSocket[] = [];
	const messages: unknown[] = [];
	const statuses: { status: PushStatus; attempt: number; retryInMs?: number }[] = [];
	let logins = 0;
	const session = new PushSession({
		url: 'ws://op/sockjs/websocket',
		throttle: 2,
		login: opts.login ?? (async () => (logins++, { name: 'octo', session: `s${logins}` })),
		createSocket: () => {
			const s = new FakeSocket();
			sockets.push(s);
			return s;
		},
		onMessage: (m) => messages.push(m),
		onStatus: (status, info) => statuses.push({ status, attempt: info.attempt, retryInMs: info.retryInMs }),
		backoff: (attempt) => [1000, 2000, 4000, 8000][Math.min(attempt, 3)],
		setTimer: c.set,
		clearTimer: c.clear,
		openTimeoutMs: 15_000,
		idleTimeoutMs: 30_000
	});
	return { session, sockets, messages, statuses, clock: c };
}

test('handshake: auth and throttle after "connected"; open on the first update', async () => {
	const { session, sockets, messages } = setup();
	session.start();
	await tick();
	assert.equal(session.state, 'connecting');
	const s = sockets[0];
	s.open();
	s.receive({ connected: { version: '1.11.8' } });
	assert.deepEqual(s.sent, [{ auth: 'octo:s1' }, { throttle: 2 }]);
	assert.equal(session.state, 'connecting', 'not open until OctoPrint sends state');
	s.receive({ history: { state: { text: 'Operational' } } });
	assert.equal(session.state, 'open');
	s.receive({ current: { state: { text: 'Operational' } } });
	assert.equal(messages.length, 3);
	session.stop();
	assert.ok(s.closed);
	assert.equal(session.state, 'stopped');
});

test('reconnects with backoff after drops, and resets the backoff once open', async () => {
	const { session, sockets, statuses, clock } = setup();
	session.start();
	await tick();
	sockets[0].onclose?.({ code: 1006, reason: '' });
	assert.equal(session.state, 'waiting');
	assert.equal(statuses.at(-1)?.retryInMs, 1000);
	clock.fire(1000);
	await tick();
	sockets[1].onerror?.({ message: 'boom' });
	assert.equal(statuses.at(-1)?.retryInMs, 2000, 'second failure waits longer');
	assert.equal(session.failures, 2);
	clock.fire(2000);
	await tick();
	const s = sockets[2];
	s.open();
	s.receive({ connected: {} });
	s.receive({ current: {} });
	assert.equal(session.state, 'open');
	assert.equal(session.failures, 0);
	s.onclose?.({ code: 1001, reason: 'going away' });
	assert.equal(statuses.at(-1)?.retryInMs, 1000, 'backoff starts over after a good connection');
	assert.match(String((session.lastError as Error).message), /1001: going away/);
	session.stop();
	assert.deepEqual(clock.pending(), [], 'stop clears every timer');
});

test('a refused login retries too, without opening a socket', async () => {
	let calls = 0;
	const { session, sockets, clock } = setup({
		login: async () => {
			calls++;
			if (calls === 1) throw new Error('API key rejected');
			return { name: 'octo', session: 'ok' };
		}
	});
	session.start();
	await tick();
	assert.equal(sockets.length, 0);
	assert.equal(session.state, 'waiting');
	clock.fire(1000);
	await tick();
	assert.equal(sockets.length, 1);
	session.stop();
});

test('watchdogs: no handshake in time, or silence once open, reconnect', async () => {
	const { session, sockets, clock } = setup();
	session.start();
	await tick();
	clock.fire(15_000);
	assert.equal(session.state, 'waiting');
	assert.match(String((session.lastError as Error).message), /Timed out/);
	assert.ok(sockets[0].closed);
	clock.fire(1000);
	await tick();
	const s = sockets[1];
	s.open();
	s.receive({ connected: {} });
	s.receive({ current: {} });
	assert.deepEqual(clock.pending(), [30_000]);
	clock.fire(30_000);
	assert.equal(session.state, 'waiting');
	assert.match(String((session.lastError as Error).message), /quiet/);
	session.stop();
});

test('reauthRequired: logs in again on a fresh socket', async () => {
	const { session, sockets, clock } = setup();
	session.start();
	await tick();
	sockets[0].open();
	sockets[0].receive({ connected: {} });
	sockets[0].receive({ current: {} });
	sockets[0].receive({ reauthRequired: { reason: 'logout' } });
	assert.equal(session.state, 'waiting');
	clock.fire(1000);
	await tick();
	sockets[1].open();
	sockets[1].receive({ connected: {} });
	assert.deepEqual(sockets[1].sent[0], { auth: 'octo:s2' }, 'a new session');
	session.stop();
});

test('stale callbacks from an old socket are ignored', async () => {
	const { session, sockets, messages, clock } = setup();
	session.start();
	await tick();
	const old = sockets[0];
	const onmessage = old.onmessage;
	old.onclose?.({ code: 1006, reason: '' });
	clock.fire(1000);
	await tick();
	onmessage?.({ data: JSON.stringify({ current: {} }) });
	assert.equal(messages.length, 0);
	assert.notEqual(session.state, 'open');
	session.stop();
});

test('backoff: exponential, capped, jittered within bounds', () => {
	const mid = () => 0.5; // no jitter
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, {}, mid)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
	assert.equal(backoffDelay(100, { maxMs: 5000 }, mid), 5000);
	for (let i = 0; i < 200; i++) {
		const d = backoffDelay(3, { jitter: 0.2 });
		assert.ok(d >= 6400 && d <= 9600, String(d));
	}
	assert.ok(backoffDelay(0, {}, () => 0) >= 800, 'never below base minus jitter');
	assert.ok(backoffDelay(20, {}, () => 1) <= 60000, 'never above max');
});
