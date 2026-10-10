import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flatten, isGcodeName, parseFileEntry, parseFileListing, safeThumbnail, validFolderName } from '../src/lib/server/octoprint/files.ts';
import { encodePath } from '../src/lib/server/octoprint/client.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/rest-files.json', import.meta.url), 'utf8'));

test('a real /api/files listing: folders, sizes, analysis and print history', () => {
	const l = parseFileListing(fixture);
	assert.ok(l.free && l.free > 0);
	const all = flatten(l.files);
	const tiny = all.find((f) => f.name === 'tiny.gcode')!;
	assert.equal(tiny.type, 'machinecode');
	assert.equal(tiny.origin, 'local');
	assert.equal(tiny.size, 3853);
	assert.ok(tiny.estimatedPrintTime! > 0);
	assert.equal(tiny.filamentMm, 3.78);
	assert.ok(tiny.prints && tiny.prints.success >= 1);
	assert.equal(tiny.prints.lastSuccess, true);
	const folder = all.find((f) => f.type === 'folder');
	assert.ok(folder && Array.isArray(folder.children));
});

test('nested folders, SD files and thumbnails', () => {
	const e = parseFileEntry({
		name: 'parts',
		path: 'parts',
		type: 'folder',
		origin: 'local',
		children: [
			{ name: 'benchy.gcode', path: 'parts/benchy.gcode', type: 'machinecode', origin: 'local', size: 10, thumbnail: 'plugin/prusaslicerthumbnails/thumbnail/parts/benchy.png?20240101', gcodeAnalysis: { estimatedPrintTime: 60, filament: { tool0: { length: 1000 }, tool1: { length: 500 } } } }
		]
	})!;
	const b = e.children![0];
	assert.equal(b.thumbnail, 'plugin/prusaslicerthumbnails/thumbnail/parts/benchy.png?20240101');
	assert.equal(b.filamentMm, 1500);
	assert.equal(parseFileEntry({ name: 'X.GCO', origin: 'sdcard', type: 'machinecode' })!.origin, 'sdcard');
	assert.equal(parseFileEntry({ type: 'machinecode' }), null, 'no name, no entry');
	assert.deepEqual(parseFileListing(null), { files: [], free: null, total: null });
});

test('only slicer thumbnail paths are proxied', () => {
	assert.equal(safeThumbnail('/plugin/UltimakerFormatPackage/thumbnail/a.png'), 'plugin/UltimakerFormatPackage/thumbnail/a.png');
	for (const bad of ['api/settings', 'plugin/x/thumbnail/../../api/settings', 'plugin/x/other/a.png', 'http://evil/plugin/x/thumbnail/a.png', 'plugin/x/thumbnail/', null, 5]) {
		assert.equal(safeThumbnail(bad), null, String(bad));
	}
});

test('names and paths', () => {
	assert.ok(isGcodeName('a.gcode') && isGcodeName('B.GCO') && isGcodeName('x.bgcode'));
	assert.ok(!isGcodeName('model.stl') && !isGcodeName('gcode'));
	assert.ok(validFolderName('My parts') && !validFolderName('a/b') && !validFolderName('..') && !validFolderName(' '));
	assert.equal(encodePath('/parts/my benchy#1.gcode'), 'parts/my%20benchy%231.gcode');
});
