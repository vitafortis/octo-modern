import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-status-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-status';
const { statusItem } = await import('../src/lib/server/status.ts');
const { emptySnapshot } = await import('../src/lib/printer.ts');

const printer = { id: 'p1', name: 'MK4', baseUrl: 'http://mk4.lan', hasApiKey: true, verifyTls: true, webcamUrl: null, color: 'violet', createdAt: '', updatedAt: '', lastSeenAt: null, octoprintVersion: '1.11.8' };

test('a printing printer: progress, time left, ETA and file', () => {
	const s = {
		...emptySnapshot('p1'),
		state: 'printing' as const,
		stateText: 'Printing',
		job: { file: { name: 'b.gcode', path: 'b.gcode', display: 'Benchy.gcode', origin: 'local', size: 1, date: 1 }, estimatedPrintTime: 100, filament: { tool0: { length: 2500, volume: null } }, user: 'me' },
		progress: { completion: 42.44, printTime: 60, printTimeLeft: 120, printTimeLeftOrigin: 'estimate', filepos: 10 },
		temps: { bed: { actual: 60, target: 60 }, tool0: { actual: 210, target: 210 } },
		updatedAt: Date.now()
	};
	const item = statusItem(printer, s, false);
	assert.equal(item.state, 'printing');
	assert.equal(item.progress, 42.4);
	assert.equal(item.file, 'Benchy.gcode');
	assert.equal(item.printTimeLeftSeconds, 120);
	assert.equal(item.filamentMeters, 2.5);
	assert.ok(item.eta && Date.parse(item.eta) > Date.now());
	assert.deepEqual(Object.keys(item.temperatures), ['tool0', 'bed']);
	assert.equal(item.url, undefined, 'no address without the token option');
	assert.equal(statusItem(printer, s, true).url, 'http://mk4.lan');
});

test('an unreachable printer reports only an error code', () => {
	const s = { ...emptySnapshot('p1'), state: 'offline' as const, problem: { message: 'Connection refused (10.0.0.5)', code: 'ECONNREFUSED' } };
	const item = statusItem(printer, s, false);
	assert.equal(item.online, false);
	assert.equal(item.error, 'ECONNREFUSED');
	assert.ok(!JSON.stringify(item).includes('10.0.0.5'));
	assert.equal(item.progress, null);
	assert.equal(item.version, '1.11.8', 'falls back to the stored version');
});
