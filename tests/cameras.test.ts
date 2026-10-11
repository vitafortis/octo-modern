import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, LIVE_LIMIT, kioskGrid, parseWallParams, streamsLive, wallQuery } from '../src/lib/cameras.ts';

const parse = (q: string) => parseWallParams(new URLSearchParams(q));

test('wall options: defaults, parsing and clamping', () => {
	assert.deepEqual(parse(''), DEFAULTS);
	const o = parse('kiosk=1&layout=3&mode=snapshot&every=5&rotate=20&printers=a,b,,c&fill=yes');
	assert.deepEqual(o, { layout: 3, kiosk: true, mode: 'snapshot', every: 5, rotate: 20, printers: ['a', 'b', 'c'], fill: true });
	assert.equal(parse('layout=7').layout, 'auto');
	assert.equal(parse('mode=weird').mode, 'auto');
	assert.equal(parse('every=0').every, 1);
	assert.equal(parse('every=99999').every, 600);
	assert.equal(parse('every=abc').every, DEFAULTS.every);
	assert.equal(parse('rotate=-5').rotate, 0);
	assert.equal(parse('kiosk=0').kiosk, false);
	assert.equal(parse('kiosk').kiosk, true, 'a bare flag turns it on');
	assert.equal(parse('printers=').printers, null);
});

test('wall options round-trip through the URL, leaving defaults out', () => {
	assert.equal(wallQuery(DEFAULTS), '');
	const o = { ...DEFAULTS, kiosk: true, layout: 2 as const, mode: 'live' as const, rotate: 30, printers: ['x y', 'z'] };
	const q = wallQuery(o);
	assert.match(q, /^kiosk=1&layout=2&mode=live&rotate=30&printers=x\+y%2Cz$/);
	assert.deepEqual(parseWallParams(new URLSearchParams(q)), o);
});

test('auto mode streams live for a few cameras and switches to snapshots for many', () => {
	assert.equal(streamsLive('auto', 1), true);
	assert.equal(streamsLive('auto', LIVE_LIMIT), true);
	assert.equal(streamsLive('auto', LIVE_LIMIT + 1), false);
	assert.equal(streamsLive('live', 20), true);
	assert.equal(streamsLive('snapshot', 1), false);
	assert.ok(LIVE_LIMIT < 6, 'stays under the browser’s six connections per host');
});

test('kiosk grids fill the screen', () => {
	assert.deepEqual(kioskGrid(0, 'auto'), { cols: 1, rows: 1 });
	assert.deepEqual(kioskGrid(1, 'auto'), { cols: 1, rows: 1 });
	assert.deepEqual(kioskGrid(2, 'auto'), { cols: 2, rows: 1 });
	assert.deepEqual(kioskGrid(4, 'auto'), { cols: 2, rows: 2 });
	assert.deepEqual(kioskGrid(5, 'auto'), { cols: 3, rows: 2 });
	assert.deepEqual(kioskGrid(5, 'auto', false), { cols: 2, rows: 3 }, 'portrait: taller than wide');
	assert.deepEqual(kioskGrid(9, 'auto'), { cols: 3, rows: 3 });
	assert.deepEqual(kioskGrid(3, 4), { cols: 3, rows: 1 }, 'never more columns than cameras');
	assert.deepEqual(kioskGrid(6, 1), { cols: 1, rows: 6 });
});
