import type { Component } from 'svelte';
import { BellRing, Cctv, Disc3, History, LayoutDashboard, LibraryBig, ListOrdered, Plug, Radar, ScrollText, Settings, Users, Wrench } from '@lucide/svelte';
import type { NavIcon } from '#lib/nav.ts';

/** The icon for each sidebar and Settings entry (#lib/nav.ts names them). */
export const NAV_ICONS: Record<NavIcon, Component> = {
	overview: LayoutDashboard,
	queue: ListOrdered,
	library: LibraryBig,
	history: History,
	cameras: Cctv,
	filament: Disc3,
	maintenance: Wrench,
	settings: Settings,
	discover: Radar,
	users: Users,
	notifications: BellRing,
	integrations: Plug,
	audit: ScrollText
};
