<script lang="ts">
	import { STATE_LABEL, stateTone, type PrinterState } from '#lib/printer.ts';
	import StateDot from './StateDot.svelte';

	let { state, text }: { state: PrinterState; text?: string } = $props();
	const cls = $derived({ success: 'badge-success', primary: 'badge-primary', warning: 'badge-warning', danger: 'badge-danger', muted: '' }[stateTone(state)]);
</script>

<span class="badge {cls} gap-1.5" title={text && text !== STATE_LABEL[state] ? text : undefined}>
	<StateDot {state} class="scale-75" />{STATE_LABEL[state]}
</span>
