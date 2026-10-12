/**
 * What the sidebar and the Settings area list, as plain data (icons by name), so the rules
 * are testable and shared by the drawer, the sidebar and the command palette. Pure.
 *
 * Sidebar: Overview (more than one printer), Queue, Library, History (with Stats), Cameras;
 * Filament once Spoolman is set up, Maintenance once there's a task (or one is overdue);
 * one Settings entry for admins. The Settings pages keep their paths (/discover, /users…)
 * and share a sub-navigation (src/routes/(settings)/+layout.svelte).
 */

export type NavIcon = 'overview' | 'queue' | 'library' | 'history' | 'cameras' | 'filament' | 'maintenance' | 'settings' | 'discover' | 'users' | 'notifications' | 'integrations' | 'audit';

export interface NavOptions {
	/** Exactly one printer: it is the app, no overview. */
	single: boolean;
	admin: boolean;
	/** Spoolman is configured. */
	spoolman: boolean;
	/** Maintenance tasks on the printers this user sees. */
	maintenanceTasks: number;
	maintenanceOverdue: number;
}

export interface NavEntry {
	href: string;
	label: string;
	icon: NavIcon;
	badge?: number;
	/** Paths that count as this entry (it's highlighted on them). */
	match: (path: string) => boolean;
}

const under = (...roots: string[]) => (path: string) => roots.some((r) => path === r || path.startsWith(`${r}/`));

/** The admin pages grouped under Settings, in sub-navigation order. Their paths predate the group and stay. */
const SETTINGS: { href: string; label: string; icon: NavIcon; description: string }[] = [
	{ href: '/settings', label: 'General', icon: 'settings', description: 'Security, data, backups' },
	{ href: '/discover', label: 'Printers & Discover', icon: 'discover', description: 'Find and add printers' },
	{ href: '/users', label: 'Users', icon: 'users', description: 'Accounts and access' },
	{ href: '/notifications', label: 'Notifications', icon: 'notifications', description: 'Channels and rules' },
	{ href: '/integrations', label: 'Integrations', icon: 'integrations', description: 'Sign-in, API tokens' },
	{ href: '/audit', label: 'Audit log', icon: 'audit', description: 'Who did what' }
];

export const SETTINGS_PATHS = SETTINGS.map((s) => s.href);
export const isSettingsPath = under(...SETTINGS_PATHS);

export function navEntries(o: NavOptions): NavEntry[] {
	const out: NavEntry[] = [];
	if (!o.single) out.push({ href: '/', label: 'Overview', icon: 'overview', match: (p) => p === '/' });
	out.push(
		{ href: '/queue', label: 'Queue', icon: 'queue', match: under('/queue') },
		{ href: '/library', label: 'Library', icon: 'library', match: under('/library') },
		{ href: '/history', label: 'History', icon: 'history', match: under('/history', '/stats') },
		{ href: '/cameras', label: 'Cameras', icon: 'cameras', match: under('/cameras') }
	);
	if (o.spoolman) out.push({ href: '/filament', label: 'Filament', icon: 'filament', match: under('/filament') });
	if (o.maintenanceTasks > 0 || o.maintenanceOverdue > 0) out.push({ href: '/maintenance', label: 'Maintenance', icon: 'maintenance', badge: o.maintenanceOverdue, match: under('/maintenance') });
	if (o.admin) out.push({ href: '/settings', label: 'Settings', icon: 'settings', match: isSettingsPath });
	return out;
}

export interface SettingsSection {
	href: string;
	label: string;
	icon: NavIcon;
	description: string;
	/** A page outside Settings, listed here to set it up while it isn't in the sidebar. */
	setup?: boolean;
	match: (path: string) => boolean;
}

/** The Settings sub-navigation: its pages, then Filament / Maintenance while they're not in the sidebar. */
export function settingsSections(o: Pick<NavOptions, 'spoolman' | 'maintenanceTasks'>): SettingsSection[] {
	const out: SettingsSection[] = SETTINGS.map((s) => ({ ...s, match: under(s.href) }));
	if (!o.spoolman) out.push({ href: '/filament', label: 'Filament', icon: 'filament', description: 'Connect Spoolman, costs', setup: true, match: under('/filament') });
	if (!(o.maintenanceTasks > 0)) out.push({ href: '/maintenance', label: 'Maintenance', icon: 'maintenance', description: 'Reminders per printer', setup: true, match: under('/maintenance') });
	return out;
}

/** Titles for the phone top bar, for pages the sidebar doesn't list by name. */
export function pageTitle(path: string, entries: Pick<NavEntry, 'href' | 'label' | 'match'>[]): string | null {
	const extra: [string, string][] = [
		['/library/sources', 'Library sources'],
		['/account', 'My account'],
		['/history/stats', 'Stats'],
		['/filament', 'Filament'],
		['/maintenance', 'Maintenance'],
		...SETTINGS.map((s): [string, string] => [s.href, s.href === '/settings' ? 'Settings' : s.label])
	];
	const hit = extra.find(([h]) => under(h)(path)) ?? entries.find((e) => e.href !== '/settings' && e.match(path));
	return hit ? (Array.isArray(hit) ? hit[1] : hit.label) : null;
}
