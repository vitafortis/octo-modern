/** Notifications page: API calls and small helpers. */
import { api } from './api.ts';
import type { ChannelInfo, Delivery, GeneralSettings, Rule } from '#lib/notify.ts';

export interface NotifySettings {
	general: GeneralSettings;
	channels: ChannelInfo[];
	rules: Rule[];
	seenUrl?: string | null;
	envOrigin?: string | null;
}

const BASE = '/api/settings/notifications';

export const notifyApi = {
	load: () => api.get<NotifySettings>(BASE),
	save: (patch: Partial<GeneralSettings> & { rules?: Rule[] }) => api.put<NotifySettings>(BASE, patch),
	create: (c: unknown) => api.post<{ channel: ChannelInfo }>(`${BASE}/channels`, c),
	update: (id: string, c: unknown) => api.put<{ channel: ChannelInfo }>(`${BASE}/channels/${encodeURIComponent(id)}`, c),
	test: (id: string | null, channel?: unknown) => api.post<{ ok: true; ms: number; image: boolean }>(`${BASE}/test`, { id, channel }),
	log: (limit = 100) => api.get<{ items: Delivery[] }>(`${BASE}/log?limit=${limit}`),
	clearLog: () => api.del(`${BASE}/log`)
};

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
