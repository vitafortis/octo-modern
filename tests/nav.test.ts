// The sidebar and the Settings area: which entries show, and the old admin paths kept under Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSettingsPath, navEntries, pageTitle, settingsSections } from '../src/lib/nav.ts';

test('sidebar: Filament and Maintenance only once in use; one Settings entry for admins', () => {
	const ids = (o: Parameters<typeof navEntries>[0]) => navEntries(o).map((e) => e.href);
	const base = { single: false, admin: false, spoolman: false, maintenanceTasks: 0, maintenanceOverdue: 0 };
	assert.deepEqual(ids(base), ['/', '/queue', '/library', '/history', '/cameras']);
	assert.deepEqual(ids({ ...base, single: true }), ['/queue', '/library', '/history', '/cameras']);
	assert.deepEqual(ids({ ...base, spoolman: true }), ['/', '/queue', '/library', '/history', '/cameras', '/filament']);
	assert.deepEqual(ids({ ...base, maintenanceTasks: 2 }), ['/', '/queue', '/library', '/history', '/cameras', '/maintenance']);
	// Anything overdue shows the entry regardless.
	assert.deepEqual(ids({ ...base, maintenanceOverdue: 1 }), ['/', '/queue', '/library', '/history', '/cameras', '/maintenance']);
	assert.deepEqual(ids({ ...base, admin: true }), ['/', '/queue', '/library', '/history', '/cameras', '/settings']);
	assert.equal(navEntries({ ...base, maintenanceTasks: 3, maintenanceOverdue: 2 }).find((e) => e.href === '/maintenance')?.badge, 2);
});

test('settings sections keep their old paths, and list setup pages not in the sidebar', () => {
	const hrefs = (o: Parameters<typeof settingsSections>[0]) => settingsSections(o).map((s) => s.href);
	const all = hrefs({ spoolman: false, maintenanceTasks: 0 });
	assert.deepEqual(all, ['/settings', '/discover', '/users', '/notifications', '/integrations', '/audit', '/filament', '/maintenance']);
	assert.deepEqual(hrefs({ spoolman: true, maintenanceTasks: 1 }), ['/settings', '/discover', '/users', '/notifications', '/integrations', '/audit']);
	const s = settingsSections({ spoolman: false, maintenanceTasks: 0 });
	assert.ok(s.find((x) => x.href === '/settings')?.match('/settings'));
	assert.ok(!s.find((x) => x.href === '/settings')?.match('/settings-other'));
	assert.ok(s.find((x) => x.href === '/discover')?.match('/discover'));
});

test('top bar titles', () => {
	const entries = navEntries({ single: false, admin: true, spoolman: false, maintenanceTasks: 0, maintenanceOverdue: 0 });
	assert.equal(pageTitle('/', entries), 'Overview');
	assert.equal(pageTitle('/history', entries), 'History');
	assert.equal(pageTitle('/history/stats', entries), 'Stats');
	assert.equal(pageTitle('/users', entries), 'Users');
	assert.equal(pageTitle('/settings', entries), 'Settings');
	assert.equal(pageTitle('/discover', entries), 'Printers & Discover');
	assert.equal(pageTitle('/maintenance', entries), 'Maintenance');
	assert.equal(pageTitle('/library/sources', entries), 'Library sources');
	assert.equal(pageTitle('/nowhere', entries), null);
	assert.ok(isSettingsPath('/audit') && isSettingsPath('/notifications') && !isSettingsPath('/history'));
});
