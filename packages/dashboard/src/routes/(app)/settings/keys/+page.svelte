<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let keys = $state(data.keys);
  let providers = data.providers;

  // Form state
  let selectedProviderId = $state(providers[0]?.id ?? 'do-inference');
  let label = $state('');
  let value = $state('');
  let baseUrl = $state('');
  let model = $state('');
  let saving = $state(false);
  let error = $state('');
  let success = $state('');

  // Derived helpers
  let activeProvider = $derived(providers.find((p: typeof providers[number]) => p.id === selectedProviderId));
  let baseUrlPlaceholder = $derived(activeProvider?.baseUrl ?? '');
  let modelPlaceholder = $derived(activeProvider?.defaultModel ?? '');

  async function refresh() {
    const r = await fetch('/api/keys');
    if (r.ok) {
      const d = await r.json();
      keys = d.keys;
    }
  }

  async function save(e: Event) {
    e.preventDefault();
    error = '';
    success = '';
    if (!value.trim()) {
      error = 'Paste your API key.';
      return;
    }
    saving = true;
    try {
      const body = {
        provider: selectedProviderId,
        label: label.trim() || undefined,
        value: value.trim(),
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
      };
      const r = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        error = d.message || `error ${r.status}`;
        return;
      }
      success = 'Saved. The plaintext value will never be shown again.';
      value = '';
      label = '';
      baseUrl = '';
      model = '';
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

<section class="kv">
  <header class="kv-head">
    <p class="kv-eyebrow">Settings → AI Provider Keys</p>
    <h1>Bring your own keys.</h1>
    <p class="kv-sub">
      Stored encrypted at rest with AES-256-GCM. The plaintext value is shown only at
      paste time and never again. Last 4 characters preview is the only thing this
      page can ever read back.
    </p>
  </header>

  <!-- Add form -->
  <form class="kv-form" onsubmit={save}>
    <h2>Add a key</h2>

    <label class="kv-field">
      <span>Provider</span>
      <select bind:value={selectedProviderId}>
        {#each providers as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
      {#if activeProvider}
        <p class="kv-help">{activeProvider.description}</p>
        {#if activeProvider.signupUrl}
          <a class="kv-link" href={activeProvider.signupUrl} target="_blank" rel="noopener">
            Get a key →
          </a>
        {/if}
      {/if}
    </label>

    <label class="kv-field">
      <span>Label <em>(optional)</em></span>
      <input
        type="text"
        bind:value={label}
        placeholder="e.g. work, personal, prod"
        maxlength="40"
      />
    </label>

    <label class="kv-field">
      <span>API key</span>
      <input
        type="password"
        bind:value
        placeholder="paste your key here"
        autocomplete="new-password"
        required
      />
    </label>

    <label class="kv-field">
      <span>Base URL <em>(optional override)</em></span>
      <input type="url" bind:value={baseUrl} placeholder={baseUrlPlaceholder} />
    </label>

    <label class="kv-field">
      <span>Default model <em>(optional)</em></span>
      <input type="text" bind:value={model} placeholder={modelPlaceholder} />
      {#if activeProvider && activeProvider.models.length}
        <p class="kv-help">
          Recommended:
          {#each activeProvider.models.slice(0, 4) as m, i}<code>{m.id}</code>{i < 3 ? ' · ' : ''}{/each}
        </p>
      {/if}
    </label>

    {#if error}<p class="kv-error">{error}</p>{/if}
    {#if success}<p class="kv-success">{success}</p>{/if}

    <button class="kv-btn" type="submit" disabled={saving}>
      {saving ? 'Saving…' : 'Save key'}
    </button>
  </form>

  <!-- Existing keys -->
  <section class="kv-list">
    <h2>Your keys</h2>
    {#if keys.length === 0}
      <p class="kv-empty">No keys yet. Add one above to enable LLM-backed tools.</p>
    {:else}
      <ul>
        {#each keys as k (k.provider + (k.label ?? ''))}
          <li class="kv-item">
            <div class="kv-item-head">
              <span class="kv-provider">{k.provider}</span>
              {#if k.label}<span class="kv-label">/ {k.label}</span>{/if}
            </div>
            <div class="kv-item-body">
              <code>{k.preview}</code>
              {#if k.model}<span class="kv-meta">model: <code>{k.model}</code></span>{/if}
              {#if k.baseUrl}<span class="kv-meta">base: <code>{k.baseUrl}</code></span>{/if}
              <span class="kv-meta">updated {new Date(k.updatedAt).toLocaleDateString()}</span>
            </div>
            <button class="kv-del" onclick={() => remove(k.provider, k.label)}>Delete</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>

<style>
  .kv {
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 24px 80px;
    color: #fdf6e3;
    font-family: 'Inter', sans-serif;
  }
  .kv-eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: #10c860;
    margin: 0 0 12px;
  }
  .kv-head h1 {
    font-family: 'Montserrat', sans-serif;
    font-weight: 700;
    font-size: 36px;
    line-height: 1.05;
    letter-spacing: -0.02em;
    margin: 0 0 14px;
  }
  .kv-sub {
    color: rgba(253, 246, 227, 0.62);
    font-size: 15px;
    line-height: 1.6;
    margin: 0 0 36px;
    max-width: 600px;
  }
  .kv-form,
  .kv-list {
    border: 1px solid rgba(253, 246, 227, 0.08);
    background: rgba(253, 246, 227, 0.015);
    border-radius: 12px;
    padding: 28px;
    margin-bottom: 24px;
  }
  .kv-form h2,
  .kv-list h2 {
    font-family: 'Montserrat', sans-serif;
    font-weight: 600;
    font-size: 18px;
    margin: 0 0 20px;
  }
  .kv-field {
    display: block;
    margin-bottom: 18px;
  }
  .kv-field > span {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(253, 246, 227, 0.62);
    margin-bottom: 8px;
  }
  .kv-field em {
    color: rgba(253, 246, 227, 0.32);
    font-style: normal;
    text-transform: none;
    letter-spacing: 0.02em;
  }
  .kv-field input,
  .kv-field select {
    width: 100%;
    padding: 12px 14px;
    background: rgba(5, 6, 10, 0.6);
    border: 1px solid rgba(253, 246, 227, 0.12);
    border-radius: 8px;
    color: #fdf6e3;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
  }
  .kv-field input:focus,
  .kv-field select:focus {
    outline: none;
    border-color: rgba(16, 200, 96, 0.5);
  }
  .kv-help {
    font-size: 12px;
    line-height: 1.5;
    color: rgba(253, 246, 227, 0.5);
    margin: 8px 0 0;
  }
  .kv-help code {
    font-family: 'JetBrains Mono', monospace;
    background: rgba(253, 246, 227, 0.04);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
  }
  .kv-link {
    display: inline-block;
    margin-top: 8px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #10c860;
    text-decoration: none;
    border-bottom: 1px dashed rgba(16, 200, 96, 0.4);
  }
  .kv-link:hover {
    color: #2ade7a;
  }
  .kv-error {
    color: #ff6b6b;
    font-size: 13px;
    margin: 12px 0 0;
  }
  .kv-success {
    color: #10c860;
    font-size: 13px;
    margin: 12px 0 0;
  }
  .kv-btn {
    margin-top: 12px;
    padding: 12px 24px;
    background: rgba(16, 200, 96, 0.1);
    border: 1px solid #10c860;
    border-radius: 999px;
    color: #fdf6e3;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: all 0.2s;
  }
  .kv-btn:hover:not(:disabled) {
    background: rgba(16, 200, 96, 0.18);
    transform: translateY(-1px);
  }
  .kv-btn:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  .kv-empty {
    color: rgba(253, 246, 227, 0.5);
    font-size: 14px;
    margin: 0;
  }
  .kv-list ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .kv-item {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 16px;
    padding: 16px 0;
    border-top: 1px solid rgba(253, 246, 227, 0.06);
    align-items: center;
  }
  .kv-item:first-child {
    border-top: none;
  }
  .kv-item-head {
    grid-column: 1 / -1;
    margin-bottom: 4px;
  }
  .kv-provider {
    font-family: 'Montserrat', sans-serif;
    font-weight: 600;
    font-size: 14px;
    color: #fdf6e3;
  }
  .kv-label {
    margin-left: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: rgba(253, 246, 227, 0.5);
  }
  .kv-item-body {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    align-items: center;
    font-size: 12px;
    color: rgba(253, 246, 227, 0.62);
    grid-column: 1;
  }
  .kv-item-body code {
    font-family: 'JetBrains Mono', monospace;
    background: rgba(253, 246, 227, 0.04);
    padding: 2px 6px;
    border-radius: 3px;
    color: #fdf6e3;
  }
  .kv-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.04em;
  }
  .kv-del {
    grid-column: 2;
    grid-row: 2;
    background: transparent;
    border: 1px solid rgba(253, 246, 227, 0.12);
    color: rgba(253, 246, 227, 0.62);
    padding: 6px 14px;
    border-radius: 999px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: all 0.2s;
  }
  .kv-del:hover {
    border-color: #ff6b6b;
    color: #ff6b6b;
  }
</style>
