import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-control-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-control';
const { axisLength, describeJog, fanCommand, jogVector, movementBlocked, stepFits, JOG_STEPS } = await import('../src/lib/control/jog.ts');
const { currentProfile, parseProfile, DEFAULT_PROFILE } = await import('../src/lib/control/profile.ts');
const { fillTemplate, parseCustomControls, renderOutput } = await import('../src/lib/control/custom.ts');
const { auditEntry, isMovement, parseControlAction, summarizeJogs } = await import('../src/lib/server/control-actions.ts');
const { Coalescer } = await import('../src/lib/server/audit-coalesce.ts');

const profile = (axes: Partial<Record<'x' | 'y' | 'z', boolean>> = {}, volume = { width: 250, depth: 210, height: 220 }) =>
	parseProfile({
		id: 'mk4',
		name: 'MK4',
		volume: { ...volume, formFactor: 'rectangular', origin: 'lowerleft' },
		axes: { x: { speed: 6000, inverted: !!axes.x }, y: { speed: 6000, inverted: !!axes.y }, z: { speed: 200, inverted: !!axes.z }, e: { speed: 300, inverted: false } },
		extruder: { count: 2, nozzleDiameter: 0.4, sharedNozzle: false },
		heatedBed: true,
		heatedChamber: false
	});

test('jog vector: direction × step, only the axes that move', () => {
	const p = profile();
	assert.deepEqual(jogVector({ x: 1 }, 10, p), { x: 10 });
	assert.deepEqual(jogVector({ x: -1 }, 0.1, p), { x: -0.1 });
	assert.deepEqual(jogVector({ y: 1, z: -1 }, 1, p), { y: 1, z: -1 });
	assert.deepEqual(jogVector({ x: 0, z: 1 }, 100, p), { z: 100 });
	assert.deepEqual(JOG_STEPS, [0.1, 1, 10, 100]);
});

test('jog vector: inverted axes in the profile flip the direction', () => {
	const p = profile({ y: true, z: true });
	assert.deepEqual(jogVector({ x: 1 }, 10, p), { x: 10 });
	assert.deepEqual(jogVector({ y: 1 }, 10, p), { y: -10 });
	assert.deepEqual(jogVector({ y: -1 }, 0.1, p), { y: 0.1 });
	assert.deepEqual(jogVector({ z: 1 }, 1, p), { z: -1 });
	// No floating point noise from 0.1 steps.
	assert.equal(jogVector({ x: 1 }, 0.1 * 3, p).x, 0.3);
});

test('steps must fit the build volume', () => {
	const small = profile({}, { width: 90, depth: 90, height: 80 });
	assert.equal(axisLength(small, 'z'), 80);
	assert.ok(stepFits(10, small, ['x', 'y']));
	assert.ok(!stepFits(100, small, ['x']));
	assert.ok(!stepFits(100, small, ['z']));
	assert.ok(stepFits(100, profile(), ['x', 'y', 'z']));
	const round = parseProfile({ volume: { width: 120, depth: 0, height: 300, formFactor: 'circular', origin: 'center' } });
	assert.equal(axisLength(round, 'y'), 120, 'a round bed is as deep as it is wide');
});

test('movement is blocked while printing, cancelling, in error or disconnected; allowed when ready or paused', () => {
	for (const s of ['printing', 'pausing', 'resuming', 'finishing', 'cancelling', 'error', 'offline', 'disconnected', 'connecting', 'unknown'] as const) assert.ok(movementBlocked(s), s);
	assert.equal(movementBlocked('operational'), null);
	assert.equal(movementBlocked('paused'), null);
	assert.match(movementBlocked('printing')!, /print is running/);
});

test('fan speed maps to M106 S0–255, 0 % is M107', () => {
	assert.equal(fanCommand(100), 'M106 S255');
	assert.equal(fanCommand(50), 'M106 S128');
	assert.equal(fanCommand(0), 'M107');
	assert.equal(fanCommand(150), 'M106 S255');
	assert.equal(fanCommand(-3), 'M107');
});

test('printer profiles: the current one, with OctoPrint defaults for gaps', () => {
	const raw = {
		profiles: {
			_default: { id: '_default', name: 'Default', default: true, current: false, extruder: { count: 1 } },
			idex: { id: 'idex', name: 'IDEX', current: true, model: 'Custom', heatedBed: false, heatedChamber: true, volume: { width: 300, depth: 300, height: 400, formFactor: 'rectangular', origin: 'center' }, extruder: { count: 2, sharedNozzle: true }, axes: { x: { inverted: true } } }
		}
	};
	const p = currentProfile(raw);
	assert.equal(p.id, 'idex');
	assert.equal(p.extruders, 2);
	assert.equal(p.sharedNozzle, true);
	assert.equal(p.heatedBed, false);
	assert.equal(p.heatedChamber, true);
	assert.equal(p.volume.origin, 'center');
	assert.equal(p.axes.x.inverted, true);
	assert.equal(p.axes.x.speed, 6000, 'missing speed falls back to the default');
	assert.equal(currentProfile({ profiles: { a: { id: 'a', name: 'A', default: true } } }).id, 'a');
	assert.deepEqual(currentProfile({}), DEFAULT_PROFILE);
	assert.deepEqual(currentProfile(null), DEFAULT_PROFILE);
});

test('custom controls: sections, commands, scripts, inputs, sliders and feedback', () => {
	const tree = parseCustomControls({
		controls: [
			{
				name: 'Lights',
				type: 'section',
				layout: 'horizontal',
				children: [
					{ name: 'On', command: 'M42 P8 S255', type: 'command' },
					{ name: 'Dim', command: 'M42 P8 S%(brightness)s', input: [{ name: 'Brightness', parameter: 'brightness', default: 128, slider: { min: 0, max: 255 } }] },
					{ name: 'Blink', commands: ['M42 P8 S0', 'G4 P200', 'M42 P8 S255'], confirm: 'Blink the lights?' }
				]
			},
			{ name: 'Purge', script: 'custom/purge.gcode', input: [{ name: 'Length', parameter: 'len', default: '20' }] },
			{ name: 'Position', regex: 'X:([-\\d.]+) Y:([-\\d.]+)', template: 'X {0} · Y {1}' },
			{ name: 'Empty', children: [{ javascript: 'alert(1)' }] },
			{ name: 'Nameless', layout: 'horizontal_grid', collapsed: true, children: [{ command: 'M114' }] },
			'garbage',
			{ children: 'nope' }
		]
	});
	assert.equal(tree.length, 4, 'the empty section and junk are dropped');
	const [lights, purge, pos, grid] = tree;
	assert.equal(lights.kind, 'section');
	if (lights.kind !== 'section') return;
	assert.equal(lights.layout, 'horizontal');
	assert.equal(lights.children.length, 3);
	const dim = lights.children[1];
	assert.ok(dim.kind === 'command');
	if (dim.kind !== 'command') return;
	assert.deepEqual(dim.inputs, [{ name: 'Brightness', parameter: 'brightness', default: '128', slider: { min: 0, max: 255, step: 1 } }]);
	const blink = lights.children[2];
	assert.ok(blink.kind === 'command' && blink.commands.length === 3 && blink.confirm === 'Blink the lights?');
	assert.deepEqual(purge, { kind: 'script', name: 'Purge', script: 'custom/purge.gcode', confirm: null, inputs: [{ name: 'Length', parameter: 'len', default: '20', slider: null }] });
	assert.deepEqual(pos, { kind: 'output', name: 'Position', regex: 'X:([-\\d.]+) Y:([-\\d.]+)', template: 'X {0} · Y {1}' });
	assert.ok(grid.kind === 'section' && grid.collapsed && grid.layout === 'horizontal_grid' && grid.name === 'Nameless');
	assert.deepEqual(parseCustomControls(null), []);
	assert.deepEqual(parseCustomControls({ controls: [] }), []);
});

test('custom controls: %(name)s placeholders and feedback templates', () => {
	assert.equal(fillTemplate('M42 P8 S%(brightness)s', { brightness: '200' }), 'M42 P8 S200');
	assert.equal(fillTemplate('M104 S%(t)d T%(tool)i', { t: '210.7', tool: 1 }), 'M104 S210 T1');
	assert.equal(fillTemplate('M117 100%% %(missing)s', {}), 'M117 100% %(missing)s');
	const logs = ['Send: M114', 'Recv: X:10.00 Y:20.00 Z:0.30 E:0.00', 'Recv: ok', 'Recv: X:11.00 Y:21.00 Z:0.30 E:0.00'];
	assert.equal(renderOutput({ regex: 'X:([-\\d.]+) Y:([-\\d.]+)', template: 'X {0} · Y {1}' }, logs), 'X 11.00 · Y 21.00');
	assert.equal(renderOutput({ regex: 'X:(?P<x>[-\\d.]+)', template: 'at {x}' }, logs), 'at 11.00', 'Python named groups work');
	assert.equal(renderOutput({ regex: 'Z:([\\d.]+)', template: 'Z={}' }, logs), 'Z=0.30');
	assert.equal(renderOutput({ regex: 'nothing', template: '{0}' }, logs), null);
	assert.equal(renderOutput({ regex: '(unclosed', template: '{0}' }, logs), null);
});

test('control actions: validation', () => {
	assert.deepEqual(parseControlAction({ action: 'jog', x: 10, y: 0 }), { action: 'jog', x: 10 });
	assert.deepEqual(parseControlAction({ action: 'jog', z: '-0.1' }), { action: 'jog', z: -0.1 });
	assert.throws(() => parseControlAction({ action: 'jog' }), /Nothing to move/);
	assert.throws(() => parseControlAction({ action: 'jog', x: 5000 }), /X must be/);
	assert.throws(() => parseControlAction({ action: 'jog', x: 'abc' }), /X must be/);
	assert.deepEqual(parseControlAction({ action: 'home' }), { action: 'home', axes: ['x', 'y', 'z'] });
	assert.deepEqual(parseControlAction({ action: 'home', axes: ['z', 'x'] }), { action: 'home', axes: ['x', 'z'] });
	assert.throws(() => parseControlAction({ action: 'home', axes: ['e'] }));
	assert.deepEqual(parseControlAction({ action: 'feedrate', factor: 150 }), { action: 'feedrate', factor: 150 });
	assert.throws(() => parseControlAction({ action: 'feedrate', factor: 20 }), /Feed rate must be a number from 50 to 200/);
	assert.throws(() => parseControlAction({ action: 'flowrate', factor: 130 }));
	assert.deepEqual(parseControlAction({ action: 'fan', speed: 55.4 }), { action: 'fan', speed: 55 });
	assert.deepEqual(parseControlAction({ action: 'extrude', amount: -2, tool: 'tool1' }), { action: 'extrude', amount: -2, tool: 'tool1' });
	assert.throws(() => parseControlAction({ action: 'extrude', amount: 0 }), /not be 0/);
	assert.throws(() => parseControlAction({ action: 'tool', tool: 'T1' }), /tool0/);
	assert.deepEqual(parseControlAction({ action: 'custom', name: 'X', commands: 'M42 P8 S0\nM114' }), { action: 'custom', name: 'X', commands: ['M42 P8 S0', 'M114'] });
	assert.deepEqual(parseControlAction({ action: 'custom', name: 'S', script: 'custom/purge.gcode', parameters: { len: 20, 'bad key': 1, obj: {} } }), { action: 'custom', name: 'S', script: 'custom/purge.gcode', parameters: { len: '20' } });
	assert.throws(() => parseControlAction({ action: 'custom', script: '../etc/passwd' }), /script name/);
	assert.throws(() => parseControlAction({ action: 'dance' }), /"action" must be/);
	assert.ok(isMovement({ action: 'jog', x: 1 }) && isMovement({ action: 'home', axes: ['x'] }) && isMovement({ action: 'extrude', amount: 1 }) && isMovement({ action: 'motors_off' }) && isMovement({ action: 'tool', tool: 'tool1' }));
	assert.ok(!isMovement({ action: 'fan', speed: 1 }) && !isMovement({ action: 'feedrate', factor: 100 }) && !isMovement({ action: 'custom', name: 'x', commands: ['M114'] }));
});

test('control actions: audit names and details', () => {
	assert.deepEqual(auditEntry({ action: 'home', axes: ['x', 'y', 'z'] }), { action: 'printer.home', detail: 'all axes' });
	assert.deepEqual(auditEntry({ action: 'home', axes: ['z'] }), { action: 'printer.home', detail: 'Z' });
	assert.deepEqual(auditEntry({ action: 'extrude', amount: -3, tool: 'tool1' }), { action: 'printer.extrude', detail: 'retract 3 mm (tool1)' });
	assert.deepEqual(auditEntry({ action: 'fan', speed: 0 }), { action: 'printer.fan', detail: 'off (M107)' });
	assert.equal(auditEntry({ action: 'feedrate', factor: 120 }).action, 'printer.feedrate');
	assert.equal(describeJog({ x: 10, y: -1 }), 'X+10 Y-1');
	assert.equal(summarizeJogs([{ x: 10 }]), 'X+10');
	assert.equal(summarizeJogs([{ x: 10 }, { x: 10 }, { y: -1 }, { x: -10 }]), '4 jogs: X+10 ×2, Y-1, X-10 (net X+10 Y-1)');
	assert.equal(summarizeJogs([{ z: 0.1 }, { z: -0.1 }]), '2 jogs: Z+0.1, Z-0.1 (net none)');
});

test('audit coalescing: a burst becomes one entry; idle, age and size close it', async () => {
	const written: number[][] = [];
	const c = new Coalescer<number>({ idleMs: 30, maxAgeMs: 10_000, maxItems: 3 });
	c.add('a', 1, (b) => written.push(b.items));
	c.add('a', 2, (b) => written.push(b.items));
	c.add('b', 9, (b) => written.push(b.items));
	assert.equal(written.length, 0);
	c.add('a', 3, (b) => written.push(b.items));
	assert.deepEqual(written, [[1, 2, 3]], 'full bursts are written at once');
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(written, [[1, 2, 3], [9]], 'idle bursts are written after idleMs');
	c.add('a', 4, (b) => written.push(b.items));
	c.flush('a');
	assert.deepEqual(written.at(-1), [4]);
	assert.equal(c.size, 0);
	let now = 0;
	const aged = new Coalescer<number>({ idleMs: 10_000, maxAgeMs: 100, now: () => now });
	const out: number[][] = [];
	aged.add('k', 1, (b) => out.push(b.items));
	now = 150;
	aged.add('k', 2, (b) => out.push(b.items));
	assert.deepEqual(out, [[1, 2]], 'old bursts are written on the next add');
	aged.flushAll();
});
