/**
 * The printer page's tabs, in order. Each tab is its own component in this folder and
 * receives `TabProps`; add a tab by adding a row here. The page keeps the active tab
 * in `?tab=<id>`.
 */
import type { Component } from 'svelte';
import { Box, Camera, Clapperboard, FolderOpen, History, LayoutDashboard, ListOrdered, Move, ScanEye, SquareTerminal, Wrench } from '@lucide/svelte';
import type { LivePrinter } from '#lib/client/live.svelte.ts';
import type { Printer } from '#lib/types.ts';
import DashboardTab from './DashboardTab.svelte';
import FilesTab from './FilesTab.svelte';
import ControlTab from './ControlTab.svelte';
import TerminalTab from './TerminalTab.svelte';
import WebcamTab from './WebcamTab.svelte';
import TimelapseTab from './TimelapseTab.svelte';
import HistoryTab from './HistoryTab.svelte';
import DetectionTab from './DetectionTab.svelte';
import QueueTab from './QueueTab.svelte';
import MaintenanceTab from './MaintenanceTab.svelte';
import PreviewTab from './PreviewTab.svelte';

export interface TabProps {
	printer: Printer;
	/** Live state over SSE: snapshot, temperature history, terminal lines, OctoPrint events (`live.on('FileAdded', …)`). */
	live: LivePrinter;
	/** The signed-in user may act on this printer (operator or admin with access). */
	canControl: boolean;
}

export interface TabDef {
	id: string;
	label: string;
	icon: Component;
	component: Component<TabProps>;
}

export const TABS: TabDef[] = [
	{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, component: DashboardTab },
	{ id: 'files', label: 'Files', icon: FolderOpen, component: FilesTab },
	{ id: 'preview', label: 'Preview', icon: Box, component: PreviewTab },
	{ id: 'control', label: 'Control', icon: Move, component: ControlTab },
	{ id: 'terminal', label: 'Terminal', icon: SquareTerminal, component: TerminalTab },
	{ id: 'webcam', label: 'Webcam', icon: Camera, component: WebcamTab },
	{ id: 'timelapse', label: 'Timelapse', icon: Clapperboard, component: TimelapseTab },
	{ id: 'history', label: 'History', icon: History, component: HistoryTab },
	{ id: 'queue', label: 'Queue', icon: ListOrdered, component: QueueTab },
	{ id: 'detection', label: 'Failure detection', icon: ScanEye, component: DetectionTab },
	{ id: 'maintenance', label: 'Maintenance', icon: Wrench, component: MaintenanceTab }
];
