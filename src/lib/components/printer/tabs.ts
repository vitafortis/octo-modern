/**
 * The printer page's six tabs and what renders them. The tabs, their sub-views and the
 * URL rules (`?tab=<id>&view=<id>`, old tab ids) live in #lib/printer-tabs.ts; this file
 * adds the icons and components. Camera, Jobs and Care switch between their views with
 * a segmented control (ViewsTab); Files and Control open theirs from inside the tab.
 */
import type { Component } from 'svelte';
import { Camera, FolderOpen, LayoutDashboard, ListOrdered, Move, Wrench } from '@lucide/svelte';
import type { LivePrinter } from '#lib/client/live.svelte.ts';
import type { Printer } from '#lib/types.ts';
import type { TabId, ViewMeta } from '#lib/printer-tabs.ts';
import DashboardTab from './DashboardTab.svelte';
import FilesSection from './FilesSection.svelte';
import ControlSection from './ControlSection.svelte';
import ViewsTab from './ViewsTab.svelte';

export interface TabProps {
	printer: Printer;
	/** Live state over SSE: snapshot, temperature history, terminal lines, OctoPrint events (`live.on('FileAdded', …)`). */
	live: LivePrinter;
	/** The signed-in user may act on this printer (operator or admin with access). */
	canControl: boolean;
	/** The tab's id. */
	tab?: TabId;
	/** The tab's open view (`?view=`), its first view when the URL names none; null for tabs without views. */
	view?: string | null;
	/** The tab's views this printer has. */
	views?: ViewMeta[];
	/** Switch to another view of this tab (null: the default), setting or clearing extra params (preview's `file`/`v`). */
	openView?: (view: string | null, params?: Record<string, string | null>) => void;
}

export const TAB_ICONS: Record<TabId, Component> = {
	dashboard: LayoutDashboard,
	files: FolderOpen,
	control: Move,
	camera: Camera,
	jobs: ListOrdered,
	care: Wrench
};

export const TAB_COMPONENTS: Record<TabId, Component<TabProps>> = {
	dashboard: DashboardTab,
	files: FilesSection,
	control: ControlSection,
	camera: ViewsTab,
	jobs: ViewsTab,
	care: ViewsTab
};
