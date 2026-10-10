<script lang="ts">
	let { size = 28 }: { size?: number } = $props();
	// Gradient ids must be unique per instance; the logo appears more than once on some pages.
	const id = $props.id();
</script>

<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" class="shrink-0">
	<defs>
		<linearGradient id="{id}-fill" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="oklch(72% 0.17 292.717)" />
			<stop offset="1" stop-color="oklch(48% 0.25 292.717)" />
		</linearGradient>
		<linearGradient id="{id}-sheen" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#fff" stop-opacity="0.22" />
			<stop offset="0.5" stop-color="#fff" stop-opacity="0" />
		</linearGradient>
	</defs>
	<rect width="32" height="32" rx="9" fill="url(#{id}-fill)" />
	<rect width="32" height="32" rx="9" fill="url(#{id}-sheen)" />
	<!-- A hotend (filament, heater block, nozzle) laying down the top layer of a print. -->
	<rect x="14.3" y="2.8" width="3.4" height="3.4" rx="0.8" fill="#fff" fill-opacity="0.7" />
	<rect x="9.5" y="5.8" width="13" height="6.4" rx="1.6" fill="#fff" />
	<path d="M12.3 12.2h7.4l-2.5 3.6h-2.4Z" fill="#fff" />
	<g stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none">
		<path d="M7.6 19.6h8.4" />
		<path d="M7.6 23.4h16.8" stroke-opacity="0.72" />
		<path d="M7.6 27.2h16.8" stroke-opacity="0.45" />
	</g>
</svg>
