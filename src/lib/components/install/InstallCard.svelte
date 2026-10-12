<script lang="ts">
	import { Download, Smartphone } from '@lucide/svelte';
	import { install, startInstall } from '#lib/client/install.svelte.ts';
</script>

{#if install.mode}
	<section class="card p-5" data-testid="install-card">
		<h2 class="flex items-center gap-2 text-sm font-semibold"><Smartphone class="size-4 text-primary" />Install app</h2>
		<p class="mt-1 text-xs text-muted-foreground">
			Put octo·modern on your {install.mode === 'ios' ? 'Home Screen' : 'home screen or in your apps'}: it opens in its own window without the browser around it, and can get push notifications.
		</p>
		<div class="mt-4 flex justify-end">
			<button class="btn btn-primary" onclick={startInstall} data-testid="install-card-button"><Download />{install.mode === 'ios' ? 'How to install' : 'Install app'}</button>
		</div>
	</section>
{/if}
