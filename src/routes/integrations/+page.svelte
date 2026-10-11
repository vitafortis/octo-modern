<script lang="ts">
	import { onMount } from 'svelte';
	import { CircleAlert, CircleCheck, Copy, KeyRound, LoaderCircle, Lock, Save, Trash2, Zap } from '@lucide/svelte';
	import { Gauge } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import ApiTokens from '#lib/components/ApiTokens.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import type { Role } from '#lib/types.ts';

	// --- SSO --------------------------------------------------------------------

	type SsoView = {
		configured: boolean;
		source: 'env' | 'ui' | null;
		config: {
			issuer: string;
			clientId: string;
			name: string;
			scopes: string;
			autoCreate: string[];
			adminEmails: string[];
			defaultRole: Role;
			redirectUri: string;
		} | null;
		hasSecret: boolean;
		redirectUri: string;
		localLoginDisabled: boolean;
		localLoginLocked: 'enabled' | 'disabled' | null;
	};

	const blankSso = () => ({
		issuer: '',
		clientId: 'octo-modern',
		clientSecret: '',
		name: 'Authentik',
		scopes: 'openid email profile',
		autoCreate: '',
		adminEmails: '',
		defaultRole: 'viewer' as Role,
		redirectUri: '',
		localLoginDisabled: false
	});

	let sso = $state<SsoView | null>(null);
	let ssoForm = $state(blankSso());
	let changeSecret = $state(true);
	let ssoBusy = $state(false);
	let ssoTest = $state<
		{ ok: true; issuer: string; pkce: boolean | null; emailScope: boolean | null } | { ok: false; error: string } | null
	>(null);
	let confirmRemoveSso = $state(false);

	const PROVIDERS = [
		{ name: 'Authentik', issuer: 'https://auth.example.com/application/o/octo-modern/' },
		{ name: 'Authelia', issuer: 'https://auth.example.com' },
		{ name: 'Keycloak', issuer: 'https://kc.example.com/realms/homelab' },
		{ name: 'Pocket ID', issuer: 'https://id.example.com' },
		{ name: 'Zitadel', issuer: 'https://zitadel.example.com' },
		{ name: 'Google', issuer: 'https://accounts.google.com' }
	];
	const issuerHint = $derived(PROVIDERS.find((p) => p.name === ssoForm.name)?.issuer ?? 'https://auth.example.com');

	function fillSso(view: SsoView) {
		sso = view;
		const c = view.config;
		ssoForm = c
			? {
					...c,
					clientSecret: '',
					autoCreate: c.autoCreate.join(', '),
					adminEmails: c.adminEmails.join(', '),
					localLoginDisabled: view.localLoginDisabled
				}
			: { ...blankSso(), localLoginDisabled: false };
		changeSecret = !view.hasSecret;
	}

	async function testSso() {
		ssoBusy = true;
		ssoTest = null;
		try {
			ssoTest = await api.post('/api/integrations/sso/test', {
				issuer: ssoForm.issuer,
				clientId: ssoForm.clientId,
				clientSecret: changeSecret ? ssoForm.clientSecret : undefined
			});
		} catch (err) {
			ssoTest = { ok: false, error: errorMessage(err) };
		} finally {
			ssoBusy = false;
		}
	}

	async function saveSso(e?: SubmitEvent) {
		e?.preventDefault();
		ssoBusy = true;
		try {
			fillSso(
				await api.put<SsoView>('/api/integrations/sso', {
					...ssoForm,
					clientSecret: changeSecret ? ssoForm.clientSecret : undefined
				})
			);
			toast('success', 'Single sign-on saved', `The login page now offers “Continue with ${ssoForm.name}”.`);
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		} finally {
			ssoBusy = false;
		}
	}

	async function removeSso() {
		fillSso(await api.del<SsoView>('/api/integrations/sso'));
		confirmRemoveSso = false;
		ssoTest = null;
		toast('success', 'Single sign-on removed');
	}

	onMount(async () => {
		await api.get<SsoView>('/api/integrations/sso').then(fillSso);
		const hash = location.hash.slice(1);
		if (hash) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }));
	});

	const ssoLocked = $derived(sso?.source === 'env');
</script>

<svelte:head><title>Integrations · octo·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Integrations" description="Sign-in providers, and API tokens for dashboards." />

	<div class="max-w-5xl space-y-5 page-x pb-12">
		<!-- SSO -->
		<section id="sso" class="card scroll-mt-6 p-5">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 class="flex items-center gap-2 text-[14px] font-semibold"><KeyRound class="size-4 text-primary" />Single sign-on (OIDC)</h2>
					<p class="mt-1 max-w-2xl text-xs text-muted-foreground">
						Let people sign in with Authentik, Authelia, Keycloak, Pocket ID, Google and other OpenID Connect providers. Matching emails can
						get an account automatically.
					</p>
				</div>
				{#if sso?.configured}
					<span class="badge badge-success"><CircleCheck />Enabled{#if ssoLocked} · via environment{/if}</span>
				{:else if sso}
					<span class="badge">Not configured</span>
				{/if}
			</div>

			{#if sso}
				<div class="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
					<span class="text-muted-foreground">Redirect URI to register with your provider:</span>
					<code class="min-w-0 flex-1 truncate font-mono">{sso.redirectUri}</code>
					<button class="btn btn-ghost btn-sm" onclick={() => (navigator.clipboard.writeText(sso!.redirectUri), toast('success', 'Copied'))}><Copy />Copy</button>
				</div>

				<form class="mt-4 space-y-4" onsubmit={saveSso}>
					{#if ssoLocked}
						<p class="flex items-center gap-1.5 text-xs text-muted-foreground"><Lock class="size-3.5" />Configured with <code class="font-mono">OCM_OIDC_*</code> environment variables — edit them there.</p>
					{/if}
					<fieldset class="grid gap-3 md:grid-cols-2" disabled={ssoLocked}>
						<div>
							<label class="label" for="sso-name">Provider</label>
							<input id="sso-name" class="input" list="sso-providers" placeholder="Authentik" bind:value={ssoForm.name} />
							<datalist id="sso-providers">{#each PROVIDERS as p (p.name)}<option value={p.name}></option>{/each}</datalist>
							<p class="mt-1 text-[11px] text-muted-foreground">Shown on the button: “Continue with {ssoForm.name || 'SSO'}”.</p>
						</div>
						<div>
							<label class="label" for="sso-issuer">Issuer URL</label>
							<input id="sso-issuer" class="input font-mono text-xs" required placeholder={issuerHint} bind:value={ssoForm.issuer} />
						</div>
						<div>
							<label class="label" for="sso-client">Client ID</label>
							<input id="sso-client" class="input font-mono text-xs" required bind:value={ssoForm.clientId} />
						</div>
						<div>
							<label class="label" for="sso-secret">Client secret</label>
							{#if changeSecret}
								<input id="sso-secret" class="input font-mono text-xs" type="password" autocomplete="off" placeholder="Leave empty for a public client" bind:value={ssoForm.clientSecret} />
							{:else}
								<button type="button" class="btn btn-secondary h-9 w-full justify-start font-normal text-muted-foreground" onclick={() => (changeSecret = true)}>
									<Lock />Stored securely — change
								</button>
							{/if}
						</div>
						<div>
							<label class="label" for="sso-auto">Create accounts automatically for</label>
							<input id="sso-auto" class="input font-mono text-xs" placeholder="*@example.com, friend@gmail.com" bind:value={ssoForm.autoCreate} />
							<p class="mt-1 text-[11px] text-muted-foreground">Leave empty to only allow people added on the Users page.</p>
						</div>
						<div class="grid grid-cols-[1fr_8rem] gap-3">
							<div>
								<label class="label" for="sso-admins">…as admin when matching</label>
								<input id="sso-admins" class="input font-mono text-xs" placeholder="you@example.com" bind:value={ssoForm.adminEmails} />
							</div>
							<div>
								<label class="label" for="sso-role">Otherwise</label>
								<select id="sso-role" class="input" bind:value={ssoForm.defaultRole}>
									<option value="viewer">Viewer</option>
									<option value="operator">Operator</option>
									<option value="admin">Admin</option>
								</select>
							</div>
						</div>
						<details class="md:col-span-2">
							<summary class="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">Advanced</summary>
							<div class="mt-3 grid gap-3 md:grid-cols-2">
								<div>
									<label class="label" for="sso-scopes">Scopes</label>
									<input id="sso-scopes" class="input font-mono text-xs" bind:value={ssoForm.scopes} />
								</div>
								<div>
									<label class="label" for="sso-redirect">Redirect URI override</label>
									<input id="sso-redirect" class="input font-mono text-xs" placeholder={sso.redirectUri} bind:value={ssoForm.redirectUri} />
								</div>
							</div>
						</details>
					</fieldset>

					<div class="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
						<div class="flex-1">
							<p class="text-[13px] font-medium">Allow password sign-in</p>
							<p class="text-[11px] text-muted-foreground">
								{#if sso.localLoginLocked}
									Set by <code class="font-mono">OCM_LOCAL_LOGIN={sso.localLoginLocked}</code>.
								{:else if !sso.configured}
									Can be turned off once single sign-on is saved and working.
								{:else}
									Turn off to make SSO the only way in. <code class="font-mono">OCM_LOCAL_LOGIN=enabled</code> brings it back if SSO breaks.
								{/if}
							</p>
						</div>
						<Switch
							label="Allow password sign-in"
							disabled={!!sso.localLoginLocked || !sso.configured}
							checked={!ssoForm.localLoginDisabled}
							onchange={(v) => (ssoForm.localLoginDisabled = !v)}
						/>
					</div>

					{#if ssoTest}
						<div class="flex items-start gap-2 rounded-lg border p-3 text-xs {ssoTest.ok ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'}">
							{#if ssoTest.ok}
								<CircleCheck class="size-4 shrink-0 text-success" />
								<div>
									<p class="font-medium">Provider found</p>
									<p class="mt-0.5 font-mono text-muted-foreground">{ssoTest.issuer}</p>
									{#if ssoTest.emailScope === false}<p class="mt-1 text-warning">The provider doesn't list the “email” scope — accounts are matched by email, so make sure it's released.</p>{/if}
								</div>
							{:else}
								<CircleAlert class="size-4 shrink-0 text-danger" />
								<div><p class="font-medium">Couldn't reach the provider</p><p class="mt-0.5 font-mono break-all text-muted-foreground">{ssoTest.error}</p></div>
							{/if}
						</div>
					{/if}

					<div class="flex items-center gap-2">
						{#if sso.configured && !ssoLocked}
							{#if confirmRemoveSso}
								<span class="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
									Remove single sign-on?
									<button type="button" class="btn btn-danger btn-sm" onclick={removeSso}>Remove</button>
									<button type="button" class="btn btn-ghost btn-sm" onclick={() => (confirmRemoveSso = false)}>Keep</button>
								</span>
							{:else}
								<button type="button" class="btn btn-ghost mr-auto text-danger hover:text-danger" onclick={() => (confirmRemoveSso = true)}><Trash2 />Remove</button>
							{/if}
						{/if}
						<button type="button" class="btn btn-secondary ml-auto" disabled={ssoBusy || !ssoForm.issuer} onclick={testSso}>
							{#if ssoBusy}<LoaderCircle class="animate-spin" />{:else}<Zap />{/if}Test
						</button>
						<button class="btn btn-primary" disabled={ssoBusy}><Save />{sso.configured ? 'Save changes' : 'Enable single sign-on'}</button>
					</div>
				</form>
			{/if}
		</section>

		<!-- Status API tokens -->
		<section id="tokens" class="card scroll-mt-6 p-5">
			<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Gauge class="size-4 text-primary" />Status API tokens</h2>
			<p class="mt-1 max-w-2xl text-xs text-muted-foreground">
				Read-only tokens for dashboards and monitors — Homepage, Glance, Uptime Kuma, Home Assistant. They only open
				<code class="font-mono">GET /api/status</code> (state, progress, time left and temperatures of each printer) and nothing else.
			</p>
			<ApiTokens />
		</section>
	</div>
</div>
