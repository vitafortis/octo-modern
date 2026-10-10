<script lang="ts">
	import { Cloud, HardDrive, KeyRound, Server } from '@lucide/svelte';
	import type { SourceKind } from '#lib/library.ts';

	let { kind, class: cls = 'size-4' }: { kind: SourceKind; class?: string } = $props();
	const Icon = $derived({ folder: HardDrive, smb: Server, sftp: KeyRound, webdav: Cloud }[kind]);
</script>

<Icon class={cls} />
