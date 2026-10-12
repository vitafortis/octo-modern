<script lang="ts">
	import { Share, SquarePlus, Smartphone } from '@lucide/svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import { dismissInstall, install } from '#lib/client/install.svelte.ts';
</script>

<!-- iPhone/iPad: Safari has no install prompt, so say where Add to Home Screen is. -->
<Dialog bind:open={install.sheetOpen} title="Install octo·modern" description="Add it to your Home Screen: it opens full screen, like an app, and can get push notifications." width="max-w-md">
	<ol class="space-y-3 text-[0.8125rem]" data-testid="install-ios-steps">
		<li class="flex items-center gap-3">
			<span class="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><Share class="size-4" /></span>
			<span>Tap <strong>Share</strong> in Safari's toolbar (at the bottom on iPhone, or behind <strong>⋯</strong>).</span>
		</li>
		<li class="flex items-center gap-3">
			<span class="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><SquarePlus class="size-4" /></span>
			<span>Scroll down and choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</span>
		</li>
		<li class="flex items-center gap-3">
			<span class="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><Smartphone class="size-4" /></span>
			<span>Open <strong>octo·modern</strong> from the Home Screen. Turn on notifications there under <strong>My account</strong>.</span>
		</li>
	</ol>
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={dismissInstall} data-testid="install-not-now">Not now</button>
		<button class="btn btn-secondary" onclick={() => (install.sheetOpen = false)}>Got it</button>
	{/snippet}
</Dialog>
