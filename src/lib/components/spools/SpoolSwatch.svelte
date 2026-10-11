<script lang="ts">
	import type { SpoolSummary } from '#lib/spools.ts';

	/** A filament colour dot (multi-colour filament as a pie). Colours are data from Spoolman, not theme tokens. */
	let { spool, size = 'size-5', class: cls = '' }: { spool: Pick<SpoolSummary, 'color' | 'colors'> | null; size?: string; class?: string } = $props();

	const bg = $derived.by(() => {
		const list = spool?.colors ?? (spool?.color ? [spool.color] : null);
		if (!list?.length) return null;
		if (list.length === 1) return list[0];
		const step = 360 / list.length;
		return `conic-gradient(${list.map((c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`).join(', ')})`;
	});
</script>

<span
	class="inline-block shrink-0 rounded-full border border-border shadow-[inset_0_0_0_1px_rgb(255_255_255/0.15)] {size} {bg ? '' : 'bg-muted'} {cls}"
	style={bg ? `background:${bg}` : undefined}
	aria-hidden="true"
></span>
