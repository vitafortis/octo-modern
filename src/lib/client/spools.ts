/**
 * Spools, cost settings and maintenance from the browser.
 */
import { invalidateAll } from '$app/navigation';
import { api, ApiError, errorMessage } from './api.ts';
import { confirmAction, toast } from './state.svelte.ts';
import type { CostSettings, MaintenanceLogEntry, MaintenanceMetric, MaintenanceTask, PrinterSpools, SpoolmanSettings, SpoolSummary } from '#lib/spools.ts';

const p = (id: string) => `/api/printers/${encodeURIComponent(id)}`;

export interface SpoolList {
	configured: boolean;
	spools: SpoolSummary[];
	error: string | null;
	inUse: Record<number, { printerId: string; printerName: string; tool: number }>;
}

export const listSpools = (fresh = false) => api.get<SpoolList>(`/api/spools${fresh ? '?fresh=1' : ''}`);
export const printerSpools = (printerId: string) => api.get<PrinterSpools>(`${p(printerId)}/spools`);

export async function setSpool(printerId: string, tool: number, spoolId: number | null): Promise<PrinterSpools | null> {
	try {
		const r = await api.put<PrinterSpools>(`${p(printerId)}/spools`, { tool, spoolId });
		toast('success', spoolId == null ? 'Spool removed' : 'Active spool set');
		return r;
	} catch (err) {
		toast('error', 'Could not set the spool', errorMessage(err));
		return null;
	}
}

export const getSpoolmanSettings = () => api.get<SpoolmanSettings>('/api/settings/spoolman');
export const saveSpoolmanSettings = (s: Partial<SpoolmanSettings> & { authValue?: string | null }) => api.put<SpoolmanSettings>('/api/settings/spoolman', s);
export const testSpoolman = () => api.post<{ ok: boolean; version?: string | null; spools?: number; message?: string }>('/api/settings/spoolman/test');

export const getCostSettings = () => api.get<CostSettings>('/api/settings/costs');
export const saveCostSettings = (s: CostSettings) => api.put<CostSettings & { costed: number }>('/api/settings/costs', s);

export async function recalculateCosts(): Promise<number | null> {
	const ok = await confirmAction({
		title: 'Recalculate every print’s cost?',
		body: 'Every finished print is costed again with today’s prices. Prints costed from a Spoolman spool keep that spool’s price.',
		confirmLabel: 'Recalculate'
	});
	if (!ok) return null;
	try {
		const r = await api.post<{ changed: number }>('/api/settings/costs/recalculate', { confirm: true });
		toast('success', `Recalculated ${r.changed} print${r.changed === 1 ? '' : 's'}`);
		return r.changed;
	} catch (err) {
		toast('error', 'Could not recalculate', errorMessage(err));
		return null;
	}
}

// --- maintenance ---------------------------------------------------------------------------

export const allMaintenance = () => api.get<{ tasks: MaintenanceTask[]; log: MaintenanceLogEntry[]; overdue: number; due: number }>('/api/maintenance');
export const printerMaintenance = (printerId: string) => api.get<{ tasks: MaintenanceTask[]; log: MaintenanceLogEntry[] }>(`${p(printerId)}/maintenance`);

export interface TaskForm {
	name: string;
	metric: MaintenanceMetric;
	interval: number;
	notes: string | null;
	lastDoneAt?: string | null;
}

export async function addTask(printerId: string, t: TaskForm): Promise<boolean> {
	try {
		await api.post(`${p(printerId)}/maintenance`, t);
		toast('success', 'Task added', t.name);
		void invalidateAll();
		return true;
	} catch (err) {
		toast('error', 'Could not add the task', errorMessage(err));
		return false;
	}
}

export async function addDefaultTasks(printerId: string, keys: string[], lastDoneAt: string | null): Promise<boolean> {
	try {
		const r = await api.post<{ added: MaintenanceTask[] }>(`${p(printerId)}/maintenance`, { defaults: keys, lastDoneAt });
		toast('success', `Added ${r.added.length} task${r.added.length === 1 ? '' : 's'}`);
		void invalidateAll();
		return true;
	} catch (err) {
		toast('error', 'Could not add the tasks', errorMessage(err));
		return false;
	}
}

export async function editTask(printerId: string, id: string, t: Partial<TaskForm>): Promise<boolean> {
	try {
		await api.patch(`${p(printerId)}/maintenance/${encodeURIComponent(id)}`, t);
		toast('success', 'Task saved');
		void invalidateAll();
		return true;
	} catch (err) {
		toast('error', 'Could not save the task', errorMessage(err));
		return false;
	}
}

export async function removeTask(printerId: string, t: MaintenanceTask): Promise<boolean> {
	const ok = await confirmAction({ title: `Remove “${t.name}”?`, body: 'The reminder goes away; its maintenance log stays.', confirmLabel: 'Remove', danger: true });
	if (!ok) return false;
	try {
		await api.del(`${p(printerId)}/maintenance/${encodeURIComponent(t.id)}?confirm=1`);
		toast('success', 'Task removed');
		void invalidateAll();
		return true;
	} catch (err) {
		toast('error', 'Could not remove the task', err instanceof ApiError ? err.message : errorMessage(err));
		return false;
	}
}

export async function markDone(printerId: string, t: MaintenanceTask, notes: string): Promise<boolean> {
	try {
		await api.post(`${p(printerId)}/maintenance/${encodeURIComponent(t.id)}/done`, { notes });
		toast('success', 'Marked done', t.name);
		void invalidateAll();
		return true;
	} catch (err) {
		toast('error', 'Could not mark it done', errorMessage(err));
		return false;
	}
}
