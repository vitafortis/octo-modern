<script lang="ts">
	import { STATE_LABEL, stateTone, type PrinterState } from '#lib/printer.ts';
	import StateDot from './StateDot.svelte';

	/** `preparing`: octo·modern is running the pre-print steps (the printer itself is still ready). */
	let { state, text, preparing = false }: { state: PrinterState; text?: string; preparing?: boolean } = $props();
	const cls = $derived(preparing ? 'badge-primary' : { success: 'badge-success', primary: 'badge-primary', warning: 'badge-warning', danger: 'badge-danger', muted: '' }[stateTone(state)]);
</script>

<span class="badge {cls} gap-1.5" title={preparing ? 'Running the pre-print steps before the print' : text && text !== STATE_LABEL[state] ? text : undefined}>
	<StateDot state={preparing ? 'printing' : state} class="scale-75" />{preparing ? 'Preparing' : STATE_LABEL[state]}
</span>
