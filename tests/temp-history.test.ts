import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TempHistory } from '../src/lib/temp-history.ts';

const s = (t: number, v = 20) => ({ t, v: { tool0: [v, 0] as [number, number] } });

test('keeps samples in order within the window', () => {
	const h = new TempHistory(10_000, 100);
	for (let t = 0; t <= 20_000; t += 1000) h.push(s(t));
	assert.equal(h.oldest()!.t, 10_000, 'older than the window is dropped');
	assert.equal(h.newest()!.t, 20_000);
	assert.equal(h.size, 11);
	assert.deepEqual(h.since(18_000).map((x) => x.t), [18_000, 19_000, 20_000]);
});

test('wraps at capacity, oldest first out', () => {
	const h = new TempHistory(1e9, 5);
	for (let t = 1; t <= 12; t++) h.push(s(t));
	assert.deepEqual(h.toArray().map((x) => x.t), [8, 9, 10, 11, 12]);
	assert.equal(h.size, 5);
});

test('out-of-order samples are ignored; same time replaces', () => {
	const h = new TempHistory(1e9, 10);
	assert.ok(h.push(s(10, 1)));
	assert.ok(!h.push(s(5, 2)));
	assert.ok(h.push(s(10, 3)));
	assert.deepEqual(h.toArray(), [s(10, 3)]);
});

test('merge folds in an older backlog (OctoPrint history after connecting)', () => {
	const h = new TempHistory(60_000, 100);
	h.push(s(50_000, 1));
	h.merge([s(10_000), s(20_000), s(50_000, 9), s(5_000)]);
	assert.deepEqual(h.toArray().map((x) => x.t), [5_000, 10_000, 20_000, 50_000]);
	assert.equal(h.newest()!.v.tool0[0], 9, 'merged sample wins on equal time');
	h.merge(Array.from({ length: 300 }, (_, i) => s(100_000 + i * 100)));
	assert.equal(h.size, 100, 'capacity holds after a large merge');
	assert.equal(h.newest()!.t, 100_000 + 299 * 100);
	h.clear();
	assert.equal(h.size, 0);
	assert.equal(h.newest(), undefined);
});
