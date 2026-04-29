<script lang="ts">
  import '../../../app.css';
  import type { PageData } from './$types';

  let { data, form }: { data: PageData; form: { error?: string } | null } = $props();

  let providers = data.providers;
  let selectedProviderId = $state(providers[0]?.id ?? 'do-inference');
  let activeProvider = $derived(providers.find((p) => p.id === selectedProviderId));
</script>

<svelte:head>
  <title>Connect your LLM — Celiums Memory</title>
</svelte:head>

<div class="min-h-screen flex" style="background: var(--c-bg);">
  <div class="hidden lg:flex w-[45%] flex-col justify-between p-12 relative overflow-hidden"
    style="background: #0A0F1A;">

    <div class="absolute top-[-20%] right-[-20%] w-[500px] h-[500px] rounded-full opacity-20"
      style="background: radial-gradient(circle, #22c55e, transparent 70%);"></div>

    <div class="relative z-10">
      <div class="flex items-center gap-3 mb-16">
        <div class="w-3 h-3 rounded-full bg-[#22c55e]"
          style="animation: pulse 2.5s ease-in-out infinite; box-shadow: 0 0 20px rgba(34,197,94,0.5);"></div>
        <span class="text-white text-lg font-bold tracking-tight">Celiums Memory</span>
      </div>

      <p class="text-[11px] tracking-[0.22em] uppercase text-[#22c55e] mb-3">Step 2 of 3 — LLM Provider</p>
      <h2 class="text-3xl font-black text-white leading-tight mb-4">
        Bring your own<br/>LLM <span class="text-[#22c55e]">key</span>.
      </h2>
      <p class="text-[#94A3B8] text-sm leading-relaxed max-w-sm">
        Memory needs an LLM to power journal, write, research and ethics tools. Your key is encrypted with AES-256-GCM and never leaves this droplet.
      </p>
    </div>

    <div class="relative z-10 space-y-5">
      {#each [
        { icon: '◈', title: 'AES-256-GCM at rest', desc: 'Master key auto-generated, mode 0600.' },
        { icon: '◎', title: 'Plaintext shown once', desc: 'After paste, only the last 4 chars are ever readable.' },
        { icon: '◉', title: 'Any OpenAI-compatible API', desc: 'DO Inference, OpenAI, Anthropic, Groq, Together…' },
        { icon: '◆', title: 'Skippable', desc: 'You can come back to /settings/keys anytime.' },
      ] as feature}
        <div class="flex items-start gap-3">
          <div class="w-8 h-8 rounded-lg bg-white/[0.05] flex items-center justify-center text-[#22c55e] text-sm shrink-0 mt-0.5">{feature.icon}</div>
          <div>
            <p class="text-white text-sm font-medium">{feature.title}</p>
            <p class="text-[#64748B] text-xs">{feature.desc}</p>
          </div>
        </div>
      {/each}
    </div>

    <div class="relative z-10">
      <div class="flex items-center gap-4 text-[11px] text-[#475569]">
        <span>Encrypted</span>
        <span class="w-1 h-1 rounded-full bg-[#334155]"></span>
        <span>Local-only</span>
        <span class="w-1 h-1 rounded-full bg-[#334155]"></span>
        <span>Never re-shown</span>
      </div>
    </div>
  </div>

  <div class="flex-1 flex items-center justify-center px-6 lg:px-16 py-12">
    <div class="w-full max-w-md">
      <div class="lg:hidden flex items-center gap-3 mb-10">
        <div class="dot"></div>
        <span class="text-lg font-bold" style="color: var(--c-text);">Celiums Memory</span>
      </div>

      <div class="mb-8">
        <p class="text-[11px] tracking-[0.22em] uppercase mb-3" style="color: var(--c-accent, #10c860);">Step 2 — LLM Provider</p>
        <h1 class="text-2xl font-bold mb-2" style="color: var(--c-text);">Connect your LLM</h1>
        <p class="text-sm" style="color: var(--c-text-secondary);">
          Pick a provider and paste your API key. Encrypted at rest, never returned in plaintext after this screen.
        </p>
      </div>

      {#if form?.error}
        <div class="text-sm p-3 rounded-lg mb-6"
          style="color: #ef4444; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2);">
          {form.error}
        </div>
      {/if}

      <form method="POST" action="?/save" class="space-y-5">
        <div>
          <label for="provider" class="block text-xs font-medium mb-1.5" style="color: var(--c-text-secondary);">Provider</label>
          <select id="provider" name="provider" class="input" bind:value={selectedProviderId}>
            {#each providers as p (p.id)}
              <option value={p.id}>{p.name}</option>
            {/each}
          </select>
          {#if activeProvider}
            <p class="text-xs mt-2" style="color: var(--c-text-muted);">{activeProvider.description}</p>
            {#if activeProvider.signupUrl}
              <a class="inline-block text-[11px] mt-1 underline decoration-dashed"
                style="color: var(--c-accent, #10c860);"
                href={activeProvider.signupUrl} target="_blank" rel="noopener">
                Get a key →
              </a>
            {/if}
          {/if}
        </div>

        <div>
          <label for="value" class="block text-xs font-medium mb-1.5" style="color: var(--c-text-secondary);">API key</label>
          <input id="value" name="value" type="password"
            class="input" placeholder="paste your key here"
            autocomplete="new-password" required />
        </div>

        <details class="text-xs" style="color: var(--c-text-secondary);">
          <summary class="cursor-pointer select-none">Advanced (optional)</summary>
          <div class="mt-3">
            <label for="model" class="block text-[11px] mb-1" style="color: var(--c-text-muted);">Default model</label>
            <input id="model" name="model" type="text"
              class="input" placeholder={activeProvider?.defaultModel ?? ''} />
            {#if activeProvider && activeProvider.models.length}
              <p class="text-[11px] mt-1.5" style="color: var(--c-text-muted);">
                Recommended:
                {#each activeProvider.models.slice(0, 3) as m, i}<code class="px-1">{m.id}</code>{i < 2 ? ' · ' : ''}{/each}
              </p>
            {/if}
            <p class="text-[11px] mt-2" style="color: var(--c-text-muted);">
              Base URL is hardcoded per provider — <code>{activeProvider?.baseUrl ?? ''}</code>. Edit the catalog in source if you self-host the provider.
            </p>
          </div>
        </details>

        <button type="submit" class="btn-primary w-full py-3 text-base">Save & continue</button>
      </form>

      <form method="POST" action="?/skip" class="mt-3">
        <button type="submit" class="w-full py-2.5 text-sm rounded-lg"
          style="background: transparent; border: 1px solid var(--c-border, rgba(253,246,227,0.12)); color: var(--c-text-muted);">
          Skip — I'll add a key later
        </button>
      </form>

      <p class="text-[11px] mt-8 leading-relaxed" style="color: var(--c-text-muted);">
        Without an LLM key the engine still runs (recall, remember, forage, sense, map_network work fine). Tools that need text generation — journal, write, research, ethics — will return a clear "no LLM configured" error.
      </p>
    </div>
  </div>
</div>

<style>
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 20px rgba(34, 197, 94, 0.5); }
    50% { box-shadow: 0 0 40px rgba(34, 197, 94, 0.15); }
  }
</style>
