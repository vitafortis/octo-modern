<script lang="ts">
	import { Boxes, Container, Radar, ScanSearch } from '@lucide/svelte';
	import type { Candidate } from '#lib/discovery.ts';

	let { source }: { source: Candidate['source'] } = $props();
	const meta = $derived(
		{
			docker: { label: 'Docker', icon: Container },
			arcane: { label: 'Arcane', icon: Boxes },
			mdns: { label: 'mDNS', icon: Radar },
			subnet: { label: 'Subnet scan', icon: ScanSearch }
		}[source.kind]
	);
</script>

<span class="badge" title={source.label}><meta.icon />{meta.label}</span>
