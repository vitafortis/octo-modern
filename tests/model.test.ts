import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LiveModel, type LiveEvent } from '../src/lib/server/octoprint/model.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('a recorded print, fed message by message', () => {
	const m = new LiveModel('p1');
	const events: LiveEvent[] = [];
	m.on((e) => events.push(e));
	const msgs = fixture('push-print.json') as unknown[];
	const states: string[] = [];
	for (const msg of msgs) {
		m.applyPush(msg);
		if (states.at(-1) !== m.snapshot.state) states.push(m.snapshot.state);
	}
	// unknown before the first state; then the print's life cycle as OctoPrint reported it.
	assert.deepEqual(states.filter((s) => s !== 'unknown'), ['operational', 'printing', 'finishing', 'operational']);
	assert.equal(m.snapshot.version, '1.11.8');
	assert.equal(m.snapshot.source, 'push');
	assert.equal(m.snapshot.job?.file?.name, 'tiny.gcode');

	const names = events.filter((e) => e.type === 'event').map((e) => (e as { name: string }).name);
	for (const n of ['FileAdded', 'PrintStarted', 'PrintDone', 'ZChange']) assert.ok(names.includes(n), n);
	assert.ok(names.includes('push:timelapse'), 'other message types pass through');

	// history: the backlog (12 samples in the fixture) plus samples from current messages.
	const history = events.find((e) => e.type === 'history') as { samples: unknown[] };
	assert.equal(history.samples.length, 12);
	assert.ok(m.history.size >= 12);
	const ts = m.history.toArray().map((s) => s.t);
	assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'history stays in time order');
	assert.ok(m.logs.length > 0);
	const reset = events.find((e) => e.type === 'log' && e.reset);
	assert.ok(reset, 'the history message resets the terminal backlog');
	assert.ok(events.some((e) => e.type === 'update' && e.samples.length > 0));
});

test('unknown and malformed messages are ignored', () => {
	const m = new LiveModel('p1');
	assert.equal(m.applyPush(null), null);
	assert.equal(m.applyPush('nope'), null);
	assert.equal(m.applyPush({}), null);
	assert.equal(m.applyPush({ current: 'garbage' }), null);
	assert.equal(m.snapshot.state, 'unknown');
	assert.equal(m.applyPush({ plugin: { plugin: 'foo', data: { a: 1 } } }), 'plugin');
});

test('REST polls: connected, disconnected, then unreachable', () => {
	const m = new LiveModel('p1');
	m.applyPoll({ printer: fixture('rest-printer.json'), job: fixture('rest-job-done.json'), version: '1.11.8' }, 1000);
	assert.equal(m.snapshot.state, 'operational');
	assert.equal(m.snapshot.source, 'poll');
	assert.ok(m.snapshot.temps.tool0);
	assert.equal(m.history.size, 1, 'a poll adds one temperature sample');

	m.applyPoll({ printer: null, job: { state: 'Offline', job: { file: {} }, progress: {} } }, 2000);
	assert.equal(m.snapshot.state, 'disconnected');
	assert.deepEqual(m.snapshot.temps, {});

	m.setProblem({ message: 'Connection refused', code: 'ECONNREFUSED', hint: 'h' }, 3000);
	assert.equal(m.snapshot.state, 'offline');
	assert.equal(m.snapshot.problem?.code, 'ECONNREFUSED');
	const before = m.snapshot;
	m.setProblem({ message: 'Connection refused', code: 'ECONNREFUSED', hint: 'h' }, 4000);
	assert.equal(m.snapshot, before, 'the same problem again is not a change');

	m.applyPoll({ printer: fixture('rest-printer.json'), job: fixture('rest-job-done.json') }, 5000);
	assert.equal(m.snapshot.problem, null, 'recovering clears the problem');
	assert.equal(m.snapshot.version, '1.11.8', 'version is kept');
});

test('listeners can move to a replacement model', () => {
	const a = new LiveModel('p1');
	let n = 0;
	a.on(() => n++);
	const b = new LiveModel('p1');
	for (const fn of a.takeListeners()) b.on(fn);
	assert.equal(a.listenerCount, 0);
	b.setProblem({ message: 'x' });
	assert.equal(n, 1);
});
