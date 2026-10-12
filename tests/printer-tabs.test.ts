// The printer page's six tabs and their views: which a printer has, how ?tab=&view= resolve,
// and that every old tab id (bookmarks, notifications already sent) lands in the right place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSearch, LEGACY_TABS, paletteEntries, printerTabPath, resolveTab, tabSearch, tabsFor, TAB_META } from '../src/lib/printer-tabs.ts';
import { hiddenTabs } from '../src/lib/printer-kind.ts';

const octo = tabsFor({ bedmesh: true }, hiddenTabs({ kind: 'octoprint' }));
const octoNoPlugin = tabsFor({}, hiddenTabs({ kind: 'octoprint' }));
const klipper = tabsFor({ bedmesh: true }, hiddenTabs({ kind: 'moonraker' }));
const views = (tabs: typeof octo, id: string) => tabs.find((t) => t.id === id)?.views?.map((v) => v.id);

test('six tabs, in order', () => {
	assert.deepEqual(
		TAB_META.map((t) => t.label),
		['Dashboard', 'Files', 'Control', 'Camera', 'Jobs', 'Care']
	);
	assert.deepEqual(octo.map((t) => t.id), ['dashboard', 'files', 'control', 'camera', 'jobs', 'care']);
	// The tabs stay; only their views come and go.
	assert.equal(klipper.length, 6);
});

test('views follow plugins and the printer kind', () => {
	assert.deepEqual(views(octo, 'camera'), ['live', 'timelapse', 'detection']);
	assert.deepEqual(views(octo, 'care'), ['maintenance', 'bed']);
	assert.deepEqual(views(octoNoPlugin, 'care'), ['maintenance']);
	// Klipper: no OctoPrint timelapse, no Bed Visualizer.
	assert.deepEqual(views(klipper, 'camera'), ['live', 'detection']);
	assert.deepEqual(views(klipper, 'care'), ['maintenance']);
	assert.deepEqual(views(octo, 'jobs'), ['history', 'queue']);
});

test('resolving ?tab= and ?view=', () => {
	assert.deepEqual(pick(resolveTab(octo, null, null)), ['dashboard', null, false]);
	assert.deepEqual(pick(resolveTab(octo, 'camera', null)), ['camera', 'live', false]);
	assert.deepEqual(pick(resolveTab(octo, 'camera', 'timelapse')), ['camera', 'timelapse', false]);
	assert.deepEqual(pick(resolveTab(octo, 'nope', 'x')), ['dashboard', null, false]);
	// A view the printer lacks: the tab's first view.
	assert.deepEqual(pick(resolveTab(klipper, 'camera', 'timelapse')), ['camera', 'live', false]);
	assert.deepEqual(pick(resolveTab(octoNoPlugin, 'care', 'bed')), ['care', 'maintenance', false]);
});

test('every old tab id maps to its new tab and view', () => {
	const expected: Record<string, [string, string]> = {
		preview: ['files', 'preview'],
		terminal: ['control', 'terminal'],
		webcam: ['camera', 'live'],
		timelapse: ['camera', 'timelapse'],
		detection: ['camera', 'detection'],
		history: ['jobs', 'history'],
		queue: ['jobs', 'queue'],
		maintenance: ['care', 'maintenance'],
		bed: ['care', 'bed']
	};
	assert.deepEqual(Object.keys(LEGACY_TABS).sort(), Object.keys(expected).sort());
	for (const [old, [tab, view]] of Object.entries(expected)) assert.deepEqual(pick(resolveTab(octo, old, null)), [tab, view, true], old);
	// Old ids for views a printer lacks still land on the tab.
	assert.deepEqual(pick(resolveTab(klipper, 'bed', null)), ['care', 'maintenance', true]);
	assert.deepEqual(pick(resolveTab(klipper, 'timelapse', null)), ['camera', 'live', true]);
	// The ids that didn't change aren't "old".
	for (const id of ['files', 'control', 'dashboard']) assert.equal(resolveTab(octo, id, null).legacy, false);
});

test('old links are rewritten, keeping their other params', () => {
	const c = (q: string) => canonicalSearch(octo, new URLSearchParams(q));
	assert.equal(c('tab=preview&file=a%2Fb.gcode&v=1-2'), '?tab=files&view=preview&file=a%2Fb.gcode&v=1-2');
	assert.equal(c('tab=preview'), '?tab=files&view=preview');
	assert.equal(c('tab=terminal'), '?tab=control&view=terminal');
	assert.equal(c('tab=history'), '?tab=jobs');
	assert.equal(c('tab=queue'), '?tab=jobs&view=queue');
	assert.equal(c('tab=maintenance'), '?tab=care');
	assert.equal(c('tab=bed'), '?tab=care&view=bed');
	assert.equal(c('tab=webcam'), '?tab=camera');
	assert.equal(c('tab=detection'), '?tab=camera&view=detection');
	assert.equal(canonicalSearch(klipper, new URLSearchParams('tab=timelapse')), '?tab=camera');
	// Current URLs stay as they are.
	assert.equal(c('tab=camera&view=timelapse'), null);
	assert.equal(c(''), null);
});

test('URLs leave the defaults out', () => {
	assert.equal(tabSearch(octo, 'dashboard'), '');
	assert.equal(tabSearch(octo, 'jobs', 'history'), '?tab=jobs');
	assert.equal(tabSearch(octo, 'jobs', 'queue'), '?tab=jobs&view=queue');
	assert.equal(tabSearch(octo, 'files', 'preview', { file: 'x.gcode', v: null }), '?tab=files&view=preview&file=x.gcode');
	assert.equal(tabSearch(octo, 'dashboard', 'whatever'), '');
	assert.equal(printerTabPath('a b', 'care', 'bed'), '/p/a%20b?tab=care&view=bed');
	assert.equal(printerTabPath('p1', 'jobs', 'history'), '/p/p1?tab=jobs');
});

test('the command palette offers each tab and each extra view', () => {
	const ids = paletteEntries(octo).map((e) => e.id);
	assert.deepEqual(ids, ['dashboard', 'files', 'files/preview', 'control', 'control/terminal', 'camera', 'camera/timelapse', 'camera/detection', 'jobs', 'jobs/queue', 'care', 'care/bed']);
	assert.ok(!paletteEntries(klipper).some((e) => e.id === 'care/bed' || e.id === 'camera/timelapse'));
	const term = paletteEntries(octo).find((e) => e.id === 'control/terminal');
	assert.equal(term?.label, 'Control › Terminal');
});

function pick(r: ReturnType<typeof resolveTab>): [string, string | null, boolean] {
	return [r.tab.id, r.view, r.legacy];
}
