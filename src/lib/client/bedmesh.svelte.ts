/**
 * The Bed tab's data and colours: API calls, and the mesh colour scale read from the theme
 * tokens (`--mesh-low/-mid/-high`), refreshed when the theme changes.
 */
import { api } from './api.ts';
import { theme } from './state.svelte.ts';
import { divergingColor, inkFor, parseOklch, type DriftSettings, type MeshSnapshot, type MeshSummary, type UpdateState } from '#lib/bedmesh.ts';

export interface PluginStatus {
	installed: boolean;
	configured: boolean;
	commands: string[];
	saveMesh: boolean;
	checkedAt: string;
	error?: string | null;
}

export interface BedMeshData {
	plugin: PluginStatus;
	update: UpdateState | null;
	latest: MeshSnapshot | null;
	history: MeshSummary[];
	settings: DriftSettings;
	referenceId: number | null;
}

const base = (id: string) => `/api/printers/${encodeURIComponent(id)}/bedmesh`;

export const bedMesh = {
	load: (id: string, refresh = false) => api.get<BedMeshData>(`${base(id)}${refresh ? '?refresh=1' : ''}`),
	mesh: (id: string, meshId: number) => api.get<MeshSnapshot>(`${base(id)}/${meshId}`),
	saveSettings: (id: string, s: Partial<DriftSettings>) => api.put<{ settings: DriftSettings; referenceId: number | null }>(base(id), s),
	remove: (id: string, meshId: number) => api.del<{ ok: true }>(`${base(id)}/${meshId}`),
	updateUrl: base
};

type Lch = [number, number, number];
const FALLBACK: { low: Lch; mid: Lch; high: Lch } = { low: [0.6, 0.14, 248], mid: [0.5, 0.01, 292], high: [0.66, 0.17, 40] };

/** The theme's mesh colours; re-read whenever the theme flips. */
class MeshPalette {
	stops = $state(FALLBACK);

	refresh() {
		if (typeof document === 'undefined') return;
		const css = getComputedStyle(document.documentElement);
		const read = (name: string, fb: Lch) => parseOklch(css.getPropertyValue(name)) ?? fb;
		this.stops = { low: read('--mesh-low', FALLBACK.low), mid: read('--mesh-mid', FALLBACK.mid), high: read('--mesh-high', FALLBACK.high) };
	}

	/** Colour for `value` on a scale centred on `center`, ±`range`. */
	color(value: number, center: number, range: number): string {
		return divergingColor(value, center, range, this.stops);
	}

	/** Readable text on a cell of this colour. */
	ink(color: string): string {
		return inkFor(color);
	}
}

export const meshPalette = new MeshPalette();

/** Keeps the palette in step with the theme; call from a component (`$effect(trackTheme)`). */
export function trackTheme() {
	void theme.value;
	// The attribute flips in the same tick; read after the style recalculates.
	queueMicrotask(() => meshPalette.refresh());
}
