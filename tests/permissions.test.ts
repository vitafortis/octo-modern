import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-perm-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-permissions';
const store = await import('../src/lib/server/store.ts');
const { accessFor, canControl, canSee, requireControl, requirePrinter, visiblePrinters } = await import('../src/lib/server/permissions.ts');
const { adminOnlyApi, controlApi, printerIdFromPath, roleAllows } = await import('../src/lib/server/access.ts');
const { parsePrinterInput } = await import('../src/lib/server/http.ts');
const { parseCommands, validTargets, isEmergencyStop } = await import('../src/lib/server/control.ts');

const printer = (name: string) => store.createPrinter({ name, baseUrl: `http://${name}.lan`, apiKey: `key-for-${name}`, verifyTls: true, webcamUrl: null, color: 'violet' });
const a = printer('a');
const b = printer('b');
const admin = store.createUser({ email: 'admin@x.io', role: 'admin' });
const operator = store.createUser({ email: 'op@x.io', role: 'operator' });
const viewer = store.createUser({ email: 'viewer@x.io', role: 'viewer' });

test('roles: admins and operators control, viewers watch', () => {
	assert.ok(canControl(admin, a));
	assert.ok(canControl(operator, a));
	assert.ok(canSee(viewer, a) && !canControl(viewer, a));
	assert.deepEqual(accessFor(viewer, a), { control: false });
	assert.deepEqual(visiblePrinters(operator).map((p) => [p.name, p.access?.control]), [['a', true], ['b', true]]);
	assert.ok(!canSee(null, a));
	assert.ok(roleAllows('operator', 'control') && !roleAllows('operator', 'admin') && !roleAllows('viewer', 'control'));
});

test('"selected" access hides other printers, even from operators', () => {
	store.updateUser(operator.id, { printerAccess: 'selected' });
	store.setGrants(operator.id, [b.id, 'not-a-printer']);
	const op = store.getUser(operator.id)!;
	assert.deepEqual(visiblePrinters(op).map((p) => p.name), ['b']);
	assert.ok(!canSee(op, a) && !canControl(op, a));
	assert.throws(() => requirePrinter(op, a.id), /not found/i, 'hidden printers look like they don’t exist');
	assert.equal(requireControl(op, b.id).id, b.id);
	assert.throws(() => requireControl(store.getUser(viewer.id)!, a.id), /only watch/);
	assert.deepEqual(store.listGrants(operator.id), [b.id], 'grants for unknown printers are dropped');
	// Admins ignore the setting.
	store.updateUser(admin.id, { printerAccess: 'selected' });
	assert.equal(visiblePrinters(store.getUser(admin.id)!).length, 2);
	store.deletePrinter(b.id);
	assert.deepEqual(store.listGrants(operator.id), [], 'grants go with the printer');
});

test('route rules: admin-only and control APIs', () => {
	for (const [m, p] of [
		['POST', '/api/printers'],
		['PUT', '/api/printers/x'],
		['DELETE', '/api/printers/x'],
		['POST', '/api/printers/test'],
		['GET', '/api/users'],
		['PATCH', '/api/users/u'],
		['GET', '/api/audit'],
		['POST', '/api/backup'],
		['GET', '/api/integrations/tokens'],
		['GET', '/api/settings']
	]) assert.ok(adminOnlyApi(m, p), `${m} ${p}`);
	for (const [m, p] of [
		['GET', '/api/printers'],
		['GET', '/api/printers/x'],
		['GET', '/api/printers/status'],
		['POST', '/api/printers/x/job']
	]) assert.ok(!adminOnlyApi(m, p), `${m} ${p}`);

	for (const p of ['/api/printers/x/job', '/api/printers/x/temperature', '/api/printers/x/command', '/api/printers/x/connection', '/api/printers/x/files/local/a.gcode']) {
		assert.ok(controlApi('POST', p), p);
		assert.ok(controlApi('DELETE', p), p);
		assert.ok(!controlApi('GET', p), p);
	}
	assert.ok(!controlApi('POST', '/api/printers/x'), 'editing the server itself is an admin rule');
	assert.equal(printerIdFromPath('/api/printers/abc/events'), 'abc');
	assert.equal(printerIdFromPath('/p/abc'), 'abc');
	assert.equal(printerIdFromPath('/api/printers/status'), undefined);
	assert.equal(printerIdFromPath('/api/printers/test'), undefined);
	assert.equal(printerIdFromPath('/api/users'), undefined);
});

test('API keys are sealed per printer and never in the public shape', () => {
	assert.equal(store.getApiKey(a.id), 'key-for-a');
	assert.ok(!JSON.stringify(store.getPrinter(a.id)).includes('key-for-a'));
	const row = store.sqlite().prepare('SELECT secret FROM printers WHERE id = ?').get(a.id) as { secret: string };
	assert.ok(!row.secret.includes('key-for-a'));
	// Moving a sealed key to another printer's row fails (bound to the id).
	const c = printer('c');
	store.sqlite().prepare('UPDATE printers SET secret = ? WHERE id = ?').run(row.secret, c.id);
	assert.throws(() => store.getApiKey(c.id));
	assert.ok(store.appliedMigrations().includes('001-initial'));
});

test('server form validation', () => {
	const p = parsePrinterInput({ baseUrl: 'octopi.lan/', apiKey: ' ABCDEF0123456789 ', verifyTls: false, webcamUrl: '/webcam/?action=stream', color: 'rose' });
	assert.deepEqual(p, { name: 'octopi.lan', baseUrl: 'http://octopi.lan', apiKey: 'ABCDEF0123456789', verifyTls: false, webcamUrl: '/webcam/?action=stream', color: 'rose' });
	assert.equal(parsePrinterInput({ baseUrl: 'http://x', color: 'neon' }).color, 'violet');
	assert.equal(parsePrinterInput({ baseUrl: 'http://x' }).apiKey, undefined, 'no key: keep the stored one');
	assert.throws(() => parsePrinterInput({ baseUrl: 'http://x' }, { requireKey: true }), /API key/);
	assert.throws(() => parsePrinterInput({ baseUrl: 'http://x', apiKey: 'has space in it' }), /unexpected/);
	assert.throws(() => parsePrinterInput({ baseUrl: 'http://x', webcamUrl: 'javascript:alert(1)' }), /webcam/);
});

test('control input: temperatures and G-code', () => {
	assert.deepEqual(validTargets({ tool0: '210.04', bed: 60 }), { tool0: 210, bed: 60 });
	assert.throws(() => validTargets({ tool0: 999 }), /0–450/);
	assert.throws(() => validTargets({ bed: -1 }), /0–200/);
	assert.throws(() => validTargets({ heater9: 1 }), /Unknown heater/);
	assert.throws(() => validTargets({}), /Nothing/);
	assert.deepEqual(parseCommands('G28\n; comment\n  M105  \n'), ['G28', 'M105']);
	assert.deepEqual(parseCommands(['G1 X10', '', 5]), ['G1 X10']);
	assert.throws(() => parseCommands(''), /No G-code/);
	assert.throws(() => parseCommands(Array(201).fill('M105')), /200/);
	assert.ok(isEmergencyStop('M112') && isEmergencyStop(' m112 ') && !isEmergencyStop('M1120') && !isEmergencyStop('G1 M112'));
});
