<script lang="ts">
	import { Bell, Boxes, Hash, House, Mail, MessageSquare, Send, Server, Smartphone, Webhook } from '@lucide/svelte';
	import type { ChannelType } from '#lib/notify.ts';

	let { type, class: cls = 'size-4' }: { type: ChannelType | string; class?: string } = $props();
	const ICONS = { ntfy: Bell, discord: MessageSquare, slack: Hash, telegram: Send, pushover: Smartphone, gotify: Server, matrix: Boxes, email: Mail, homeassistant: House, webhook: Webhook };
	const Icon = $derived(ICONS[type as ChannelType] ?? Bell);
</script>

<Icon class={cls} />
