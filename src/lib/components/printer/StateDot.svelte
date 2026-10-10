<script lang="ts">
	import { STATE_LABEL, stateTone, type PrinterState } from '#lib/printer.ts';

	let { state, class: cls = '' }: { state: PrinterState | undefined; class?: string } = $props();

	const tone = $derived(state ? stateTone(state) : 'muted');
	const color = $derived(
		{
			success: 'bg-success shadow-[0_0_6px_var(--success)]',
			primary: 'bg-primary shadow-[0_0_6px_var(--primary)]',
			warning: 'bg-warning',
			danger: 'bg-danger',
			muted: 'bg-muted-foreground/40'
		}[tone]
	);
</script>

<span class="relative inline-flex size-2 shrink-0 {cls}" title={state ? STATE_LABEL[state] : 'Loading'}>
	{#if state === 'printing' || state === 'connecting'}
		<span class="absolute inset-0 animate-ping rounded-full opacity-50 {color}"></span>
	{/if}
	<span class="relative size-2 rounded-full {color} {state ? '' : 'animate-pulse'}"></span>
</span>
