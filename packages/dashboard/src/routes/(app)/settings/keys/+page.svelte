<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let keys = $state(data.keys);
  let providers = data.providers;

  let selectedProviderId = $state(providers[0]?.id ?? 'do-inference');
  let label = $state('');
  let value = $state('');
  let model = $state('');
  let saving = $state(false);
  let probing = $state(false);
  let probeError = $state('');
  let probeOk = $state(false);
  let probedModels = $state<{ id: string; context?: number }[]>([]);
  let saveError = $state('');
  let saveSuccess = $state('');
  let probeAbort: AbortController | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;

  let activeProvider = $derived(providers.find((p: typeof providers[number]) => p.id === selectedProviderId));

  // Reset probe state when provider or value changes; debounce to avoid hammering.
  $effect(() => {
    // depend on these:
    selectedProviderId;
    value;
    probeOk = false;
    probedModels = [];
    probeError = '';
    if (probeTimer) clearTimeout(probeTimer);
    if (probeAbort) probeAbort.abort();
    if (!value || value.trim().length < 8) return;
    probeTimer = setTimeout(probe, 600);
  });

  async function probe() {
    if (!value.trim()) return;
    probing = true;
    probeError = '';
    probeOk = false;
    probedModels = [];
    probeAbort = new AbortController();
    try {
      const r = await fetch('/api/keys/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: selectedProviderId, value: value.trim() }),
        signal: probeAbort.signal,
      });
      const d = await r.json();
      if (!r.ok) {
        probeError = d.message || `error ${r.status}`;
        return;
      }
      if (!d.ok) {
        probeError = d.error || 'Could not validate the key.';
        return;
      }
      probeOk = true;
      probedModels = d.models ?? [];
      if (!model && d.defaultModel) model = d.defaultModel;
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        probeError = (err as Error).message;
      }
    } finally {
      probing = false;
    }
  }

  async function refresh() {
    const r = await fetch('/api/keys');
    if (r.ok) {
      const d = await r.json();
      keys = d.keys;
    }
  }

  async function save(e: Event) {
    e.preventDefault();
    saveError = '';
    saveSuccess = '';
    if (!value.trim()) {
      saveError = 'Paste your API key.';
      return;
    }
    saving = true;
    try {
      const body = {
        provider: selectedProviderId,
        label: label.trim() || undefined,
        value: value.trim(),
        model: model.trim() || undefined,
      };
      const r = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        saveError = d.message || `error ${r.status}`;
        return;
      }
      saveSuccess = 'Saved. The plaintext value will never be shown again.';
      value = '';
      label = '';
      model = '';
      probeOk = false;
      probedModels = [];
      await refresh();
    } finally {
      saving = false;
    }
  }

  async function remove(provider: string, lbl?: string) {
    if (!confirm(`Delete the ${provider}${lbl ? ' / ' + lbl : ''} key?`)) return;
    const params = new URLSearchParams({ provider });
    if (lbl) params.set('label', lbl);
    const r = await fetch('/api/keys?' + params.toString(), { method: 'DELETE' });
    if (r.ok) await refresh();
  }
</script>

<svelte:head>
  <title>AI Provider Keys — Celiums Memory</title>
</svelte:head>

<section class="max-w-3xl">
  <header class="mb-8">
    <p class="text-[11px] tracking-[0.22em] uppercase mb-3" style="color: var(--c-celiums);">
      Settings → AI Provider Keys
    </p>
    <h1 class="text-3xl font-black mb-3 leading-tight" style="color: var(--c-text);">Bring your own keys.</h1>
    <p class="text-sm leading-relaxed max-w-xl" style="color: var(--c-text-secondary);">
      Stored encrypted at rest with AES-256-GCM. The plaintext value is shown only at paste
      time and never again — last 4 characters are the only thing this page can ever read back.
    </p>
  </header>

  <!-- Add form -->
  <form class="glass-card p-6 mb-4" onsubmit={save}>
    <h2 class="text-base font-semibold mb-5" style="color: var(--c-text);">Add a key</h2>

    <div class="mb-5">
      <label for="provider" class="block text-[11px] uppercase tracking-[0.18em] mb-1.5" style="color: var(--c-text-muted);">
        Provider
      </label>
      <select id="provider" class="input" bind:value={selectedProviderId}>
        {#each providers as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
      {#if activeProvider}
        <p class="text-[11px] mt-2" style="color: var(--c-text-muted);">{activeProvider.description}</p>
        {#if activeProvider.signupUrl}
          <a class="inline-block text-[11px] mt-1.5 underline decoration-dashed"
            style="color: var(--c-celiums);"
            href={activeProvider.signupUrl} target="_blank" rel="noopener">
            Get a key →
          </a>
        {/if}
      {/if}
    </div>

    <div class="mb-5">
      <label for="label" class="block text-[11px] uppercase tracking-[0.18em] mb-1.5" style="color: var(--c-text-muted);">
        Label <span style="color: var(--c-text-faint); text-transform: none; letter-spacing: normal;">(optional)</span>
      </label>
      <input id="label" type="text" class="input" bind:value={label} placeholder="e.g. work, personal, prod" maxlength="40" />
    </div>

    <div class="mb-5">
      <label for="value" class="block text-[11px] uppercase tracking-[0.18em] mb-1.5" style="color: var(--c-text-muted);">
        API key
      </label>
      <input id="value" type="password" class="input" bind:value placeholder="paste your key here" autocomplete="new-password" required />
      <div class="text-[11px] mt-2 min-h-[16px]" style="color: var(--c-text-muted);">
        {#if probing}
          Validating with <code style="color: var(--c-text-secondary);">{activeProvider?.baseUrl}/models</code>…
        {:else if probeOk}
          <span style="color: var(--c-celiums);">✓ Validated.</span>
          {probedModels.length} model{probedModels.length === 1 ? '' : 's'} available.
        {:else if probeError}
          <span style="color: #ef4444;">{probeError}</span>
        {:else if value.length >= 8}
          Will validate on blur…
        {/if}
      </div>
    </div>

    <div class="mb-5">
      <label for="model" class="block text-[11px] uppercase tracking-[0.18em] mb-1.5" style="color: var(--c-text-muted);">
        Default model <span style="color: var(--c-text-faint); text-transform: none; letter-spacing: normal;">(optional)</span>
      </label>
      {#if probedModels.length}
        <select id="model" class="input" bind:value={model}>
          <option value="">— use provider default ({activeProvider?.defaultModel ?? '—'}) —</option>
          {#each probedModels as m (m.id)}
            <option value={m.id}>{m.id}</option>
          {/each}
        </select>
        <p class="text-[11px] mt-2" style="color: var(--c-text-muted);">
          Picked live from your account. Leave blank to fall back to <code style="color: var(--c-text-secondary);">{activeProvider?.defaultModel}</code>.
        </p>
      {:else}
        <input id="model" type="text" class="input" bind:value={model} placeholder={activeProvider?.defaultModel ?? ''} />
        <p class="text-[11px] mt-2" style="color: var(--c-text-muted);">
          Paste a key above to auto-load the model list, or type a model id manually.
        </p>
      {/if}
    </div>

    {#if saveError}
      <p class="text-sm p-3 rounded-lg mb-4" style="color: #ef4444; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2);">
        {saveError}
      </p>
    {/if}
    {#if saveSuccess}
      <p class="text-sm p-3 rounded-lg mb-4" style="color: var(--c-celiums); background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.2);">
        {saveSuccess}
      </p>
    {/if}

    <button type="submit" class="btn-primary px-6 py-2.5 text-sm" disabled={saving}>
      {saving ? 'Saving…' : 'Save key'}
    </button>
  </form>

  <!-- Existing keys -->
  <section class="glass-card p-6">
    <h2 class="text-base font-semibold mb-4" style="color: var(--c-text);">Your keys</h2>
    {#if keys.length === 0}
      <p class="text-sm" style="color: var(--c-text-muted);">No keys yet. Add one above to enable LLM-backed tools.</p>
    {:else}
      <ul class="divide-y" style="border-color: var(--c-border);">
        {#each keys as k (k.provider + (k.label ?? ''))}
          <li class="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-4">
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2 mb-1">
                <span class="text-sm font-semibold" style="color: var(--c-text);">{k.provider}</span>
                {#if k.label}
                  <span class="text-[11px]" style="color: var(--c-text-muted);">/ {k.label}</span>
                {/if}
              </div>
              <div class="flex flex-wrap gap-3 text-[11px]" style="color: var(--c-text-muted);">
                <code style="color: var(--c-text-secondary); background: var(--c-bg-subtle); padding: 1px 6px; border-radius: 3px;">{k.preview}</code>
                {#if k.model}<span>model: <code style="color: var(--c-text-secondary);">{k.model}</code></span>{/if}
                <span>updated {new Date(k.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
            <button
              onclick={() => remove(k.provider, k.label)}
              class="text-[11px] px-3 py-1.5 rounded-full transition-colors hover:!border-[#ef4444] hover:!text-[#ef4444]"
              style="border: 1px solid var(--c-border); color: var(--c-text-muted);"
            >
              Delete
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>
