<script lang="ts">
	import { CircleCheck, CircleMinus, TriangleAlert } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import { confirmation } from '#lib/client/state.svelte.ts';

	const req = $derived(confirmation.request);
	let checked = $state(false);
	$effect(() => {
		void req;
		checked = false;
	});

	function finish(ok: boolean) {
		const r = confirmation.request;
		confirmation.request = null;
		r?.resolve(ok, checked);
	}
</script>

<Dialog bind:open={() => !!req, (v) => !v && finish(false)} title={req?.title ?? ''} width="max-w-md">
	{#if req}
		<div class="flex gap-3">
			{#if req.danger}
				<span class="grid size-9 shrink-0 place-items-center rounded-full bg-danger/10 text-danger"><TriangleAlert class="size-4" /></span>
			{/if}
			<div class="min-w-0 flex-1 space-y-3 text-[0.8125rem] text-muted-foreground">
				{#if req.body}<p>{req.body}</p>{/if}
				{#if req.steps?.length}
					<ul class="space-y-2" data-testid="confirm-steps">
						{#each req.steps as step, i (i)}
							{@const off = !step.run || checked}
							<li class="flex gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 {off ? 'opacity-70' : ''}">
								{#if off}<CircleMinus class="mt-0.5 size-4 shrink-0 text-muted-foreground" />{:else}<CircleCheck class="mt-0.5 size-4 shrink-0 text-primary" />{/if}
								<div class="min-w-0 flex-1">
									<p class="flex flex-wrap items-center gap-x-2 text-foreground">
										<span class="font-medium {off ? 'line-through decoration-muted-foreground/60' : ''}">{step.label}</span>
										<span class="badge {step.run && !checked ? 'badge-primary' : ''}">{!step.run ? 'already in file' : checked ? 'skipped' : 'will run'}</span>
									</p>
									<p class="mt-0.5 text-[0.6875rem]">{step.reason}</p>
									{#if step.commands.length}<p class="mt-1 truncate font-mono text-[0.6875rem] text-foreground/80" title={step.commands.join('\n')}>{step.commands.join(' · ')}</p>{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
				{#if req.detail}
					<pre class="max-h-48 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-[0.6875rem] whitespace-pre-wrap text-foreground">{req.detail}</pre>
				{/if}
				{#if req.option}
					<label class="flex min-h-9 cursor-pointer items-start gap-2.5 text-foreground touch:min-h-11">
						<input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" bind:checked data-testid="confirm-option" />
						<span><span class="text-[0.8125rem] font-medium">{req.option.label}</span>{#if req.option.hint}<span class="block text-[0.6875rem] text-muted-foreground">{req.option.hint}</span>{/if}</span>
					</label>
				{/if}
			</div>
		</div>
	{/if}
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => finish(false)}>Cancel</button>
		<!-- svelte-ignore a11y_autofocus -->
		<button class="btn {req?.danger ? 'btn-danger' : 'btn-primary'}" autofocus onclick={() => finish(true)}>{checked && req?.steps?.some((s) => s.run) ? 'Print' : (req?.confirmLabel ?? 'Confirm')}</button>
	{/snippet}
</Dialog>
