/** Care › Plugins & updates: API calls (admins only). Shapes live in #lib/plugins.ts. */
import { api } from './api.ts';
import type { PluginList, PluginOp, Repository, UpdateCheck, UpdateSummary } from '#lib/plugins.ts';

export type PluginsData =
	| ({
			access: 'ok';
			restartNeeded: boolean;
			pending: number;
			/** OctoPrint has a restart command; null when it couldn't be asked. */
			restartCommand: boolean | null;
			op: PluginOp | null;
			updates: UpdateSummary | null;
			printing: boolean;
	  } & PluginList)
	| { access: 'forbidden'; message: string; hint?: string; op: PluginOp | null };

const base = (id: string) => `/api/printers/${encodeURIComponent(id)}/plugins`;

export const pluginsApi = {
	url: base,
	load: (id: string) => api.get<PluginsData>(base(id)),
	repository: (id: string, refresh = false) => api.get<Repository>(`${base(id)}/repository${refresh ? '?refresh=1' : ''}`),
	updates: (id: string, force = false) => api.get<UpdateCheck>(`${base(id)}/updates${force ? '?force=1' : ''}`),
	op: (id: string) => api.get<{ op: PluginOp | null }>(`${base(id)}/op`)
};
