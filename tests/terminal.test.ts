import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HIDDEN, FILTERS, highlight, lineKind, makeLineFilter, matchesSearch } from '../src/lib/terminal/filters.ts';
import { GCODES, commandOf, completeGcode, dangerReason, gcodeInfo, uppercaseLine } from '../src/lib/terminal/gcodes.ts';

const filter = (id: string) => FILTERS.find((f) => f.id === id)!.test;

test('filters: temperature polls and reports', () => {
	const t = filter('temperature');
	for (const l of ['Send: M105', 'Send: N123 M105*45', 'Recv: ok T:210.0 /210.0 B:60.0 /60.0 @:64 B@:0', 'Recv:  T:21.3 /0.0 B:21.0 /0.0 @:0 B@:0', 'Recv: T0:200.0 /200.0 T1:25.0 /0.0 B:60.0 /60.0', 'Recv: ok N12 P15 B3 T:21.0 /0.0', 'Recv: B:60.1 /60.0'])
		assert.ok(t(l), l);
	for (const l of ['Send: M104 S210', 'Send: G28', 'Recv: ok', 'Recv: echo:busy: processing', 'Recv: X:10.00 Y:20.00 Z:0.30 E:0.00 Count X:0', 'Recv: TMC driver error'])
		assert.ok(!t(l), l);
});

test('filters: ok, SD status, wait, busy', () => {
	assert.ok(filter('ok')('Recv: ok'));
	assert.ok(filter('ok')('Recv: ok N5 P15 B3'));
	assert.ok(!filter('ok')('Recv: ok T:21.0 /0.0'), 'an ok with a temperature report is a temperature line');
	assert.ok(!filter('ok')('Recv: okay then'));
	assert.ok(filter('sd')('Send: M27'));
	assert.ok(filter('sd')('Send: N44 M27*12'));
	assert.ok(filter('sd')('Recv: SD printing byte 1234/5678'));
	assert.ok(filter('sd')('Recv: Not SD printing'));
	assert.ok(!filter('sd')('Send: M23 file.gco'));
	assert.ok(filter('wait')('Recv: wait'));
	assert.ok(!filter('wait')('Recv: waiting for heater'));
	assert.ok(filter('busy')('Recv: echo:busy: processing'));
	assert.ok(filter('busy')('Recv: busy: paused for user'));
});

test('filters: combined, and nothing hidden passes everything', () => {
	const lines = ['Send: M105', 'Recv: ok T:21.0 /0.0', 'Send: G28', 'Recv: ok', 'Recv: wait', 'Send: M27', 'Recv: echo:busy: processing', 'Changing monitoring state from "Operational" to "Printing"'];
	assert.deepEqual(lines.filter(makeLineFilter(DEFAULT_HIDDEN)), ['Send: G28', 'Recv: ok', 'Recv: echo:busy: processing', 'Changing monitoring state from "Operational" to "Printing"']);
	assert.deepEqual(lines.filter(makeLineFilter(['temperature', 'ok', 'sd', 'wait', 'busy'])), ['Send: G28', 'Changing monitoring state from "Operational" to "Printing"']);
	assert.deepEqual(lines.filter(makeLineFilter([])), lines);
});

test('search and highlight are case-insensitive', () => {
	assert.ok(matchesSearch('Send: G28 X', 'g28'));
	assert.ok(matchesSearch('anything', '  '));
	assert.ok(!matchesSearch('Send: G28', 'M104'));
	assert.deepEqual(highlight('G1 X10 g1', 'g1'), [
		{ text: 'G1', hit: true },
		{ text: ' X10 ', hit: false },
		{ text: 'g1', hit: true }
	]);
	assert.deepEqual(highlight('abc', ''), [{ text: 'abc', hit: false }]);
});

test('line kinds colour sends, receives, errors and warnings', () => {
	assert.equal(lineKind('Send: G28'), 'send');
	assert.equal(lineKind('Recv: ok'), 'recv');
	assert.equal(lineKind('Recv: Error:Printer halted. kill() called!'), 'error');
	assert.equal(lineKind('Recv: !! THERMAL RUNAWAY'), 'error');
	assert.equal(lineKind('Recv: Resend: 12'), 'warn');
	assert.equal(lineKind('Connecting to: VIRTUAL'), 'info');
});

test('G-code data: unique codes, descriptions, numeric order within each letter', () => {
	const codes = GCODES.map((g) => g.code);
	assert.equal(new Set(codes).size, codes.length, 'no duplicates');
	for (const g of GCODES) {
		assert.match(g.code, /^[GM]\d+$/);
		assert.ok(g.description.length > 3, g.code);
		assert.ok(!g.danger || g.danger.length > 10, g.code);
	}
	for (const letter of ['G', 'M']) {
		const nums = GCODES.filter((g) => g.code[0] === letter).map((g) => Number(g.code.slice(1)));
		assert.deepEqual(nums, [...nums].sort((a, b) => a - b), `${letter} codes in order`);
	}
	for (const c of ['G28', 'M104', 'M105', 'M106', 'M107', 'M112', 'M114', 'M500', 'M502', 'M999']) assert.ok(codes.includes(c), c);
});

test('autocomplete: prefix matches, exact first, nothing for non-codes', () => {
	assert.deepEqual(completeGcode('m10', 20).map((g) => g.code), ['M104', 'M105', 'M106', 'M107', 'M109']);
	assert.equal(completeGcode('M1')[0].code, 'M1', 'an exact match leads');
	assert.equal(completeGcode('g2')[0].code, 'G2');
	assert.ok(completeGcode('M').length > 0 && completeGcode('M').length <= 8);
	assert.deepEqual(completeGcode('M0104').map((g) => g.code), ['M104']);
	assert.deepEqual(completeGcode('T0'), []);
	assert.deepEqual(completeGcode('hello'), []);
	assert.deepEqual(completeGcode('M9999'), []);
});

test('dangerous commands need confirming; normalization of line numbers and leading zeros', () => {
	for (const l of ['M112', 'm999', 'M500', 'M502', 'N12 M500*33', 'M997', 'M0', 'M01 ; wait', 'M303 E0 S210 C8'])
		assert.ok(dangerReason(l), l);
	for (const l of ['M105', 'G28', 'M5000', 'M50', 'M117 M500 is dangerous', '; M112', 'G1 X10']) assert.equal(dangerReason(l), null, l);
	assert.equal(commandOf('n5 g1 x10'), 'G1');
	assert.equal(commandOf('G29.1'), 'G29');
	assert.equal(commandOf('T1'), 'T1');
	assert.equal(commandOf('hello'), null);
	assert.equal(gcodeInfo('M106 S255')?.description, 'Fan on (S0–255)');
});

test('uppercase normalization keeps messages, file names and comments', () => {
	assert.equal(uppercaseLine('g1 x10 f3000'), 'G1 X10 F3000');
	assert.equal(uppercaseLine('m117 Hello world'), 'M117 Hello world');
	assert.equal(uppercaseLine('m23 benchy.gco'), 'M23 benchy.gco');
	assert.equal(uppercaseLine('g28 ; home first'), 'G28 ; home first');
	assert.equal(uppercaseLine('t1'), 'T1');
});
