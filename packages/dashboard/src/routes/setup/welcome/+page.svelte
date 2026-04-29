<script lang="ts">
  import '../../../app.css';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let copied = $state(false);
  async function copyKey() {
    try {
      await navigator.clipboard.writeText(data.apiKey);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      copied = false;
    }
  }

  let engineOk = $derived(data.health?.status === 'ok' || data.health?.status === 'online');
  let llmConfigured = $derived(data.keys.length > 0);
</script>

<svelte:head>
  <title>Welcome — Celiums Memory</title>
</svelte:head>

<div class="min-h-screen px-6 py-12 lg:py-20" style="background: var(--c-bg);">
  <div class="max-w-3xl mx-auto">

    <header class="mb-12">
      <div class="flex items-center gap-3 mb-8">
        <div class="w-3 h-3 rounded-full bg-[#22c55e]"
          style="animation: pulse 2.5s ease-in-out infinite; box-shadow: 0 0 20px rgba(34,197,94,0.5);"></div>
        <span class="text-lg font-bold" style="color: var(--c-text);">Celiums Memory</span>
      </div>

      <p class="text-[11px] tracking-[0.22em] uppercase mb-3" style="color: var(--c-accent, #10c860);">Step 3 of 3 — Welcome</p>
      <h1 class="text-3xl lg:text-4xl font-black mb-3 leading-tight" style="color: var(--c-text);">
        You're in, <span style="color: var(--c-accent, #10c860);">{data.username}</span>.
      </h1>
      <p class="text-sm max-w-xl" style="color: var(--c-text-secondary);">
        Your engine is live. Below is the API key your AI agents will use to talk to it. <strong>Copy it now</strong> — for security it's never shown again on any other screen.
      </p>
    </header>

    <!-- API key card -->
    <section class="rounded-xl p-6 mb-6"
      style="border: 1px solid var(--c-border, rgba(253,246,227,0.12)); background: rgba(253,246,227,0.015);">
      <p class="text-[11px] tracking-[0.22em] uppercase mb-3" style="color: var(--c-text-secondary);">Your API key</p>
      <div class="flex items-stretch gap-3">
        <code class="flex-1 px-4 py-3 rounded-lg font-mono text-sm break-all"
          style="background: rgba(5,6,10,0.6); border: 1px solid rgba(253,246,227,0.08); color: var(--c-text);">
          {data.apiKey}
        </code>
        <button onclick={copyKey} class="btn-primary px-5 text-sm whitespace-nowrap">
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <p class="text-[11px] mt-3" style="color: var(--c-text-muted);">
        Stored locally at <code>celiums-auth.json</code> with scrypt-hashed credentials. Rotate anytime from <code>/settings</code>.
      </p>
    </section>

    <!-- Status -->
    <section class="grid sm:grid-cols-2 gap-4 mb-10">
      <div class="rounded-xl p-5"
        style="border: 1px solid var(--c-border, rgba(253,246,227,0.12)); background: rgba(253,246,227,0.015);">
        <div class="flex items-center gap-2 mb-1.5">
          <div class="w-2 h-2 rounded-full" style="background: {engineOk ? '#22c55e' : '#ef4444'};"></div>
          <p class="text-xs uppercase tracking-[0.18em]" style="color: var(--c-text-secondary);">Engine</p>
        </div>
        <p class="text-sm font-medium" style="color: var(--c-text);">
          {engineOk ? 'Online — accepting requests' : 'Offline — check celiums-engine service'}
        </p>
        {#if data.health?.mode}
          <p class="text-[11px] mt-1" style="color: var(--c-text-muted);">mode: {data.health.mode}</p>
        {/if}
      </div>

      <div class="rounded-xl p-5"
        style="border: 1px solid var(--c-border, rgba(253,246,227,0.12)); background: rgba(253,246,227,0.015);">
        <div class="flex items-center gap-2 mb-1.5">
          <div class="w-2 h-2 rounded-full" style="background: {llmConfigured ? '#22c55e' : '#f59e0b'};"></div>
          <p class="text-xs uppercase tracking-[0.18em]" style="color: var(--c-text-secondary);">LLM Provider</p>
        </div>
        <p class="text-sm font-medium" style="color: var(--c-text);">
          {#if llmConfigured}
            {data.keys[0].provider}{data.keys[0].label ? ' / ' + data.keys[0].label : ''} configured
          {:else}
            Not configured — journal/write/research disabled
          {/if}
        </p>
        {#if !llmConfigured}
          <a href="/settings/keys" class="text-[11px] mt-1 inline-block underline decoration-dashed"
            style="color: var(--c-accent, #10c860);">Add a key →</a>
        {/if}
      </div>
    </section>

    <!-- Integrations -->
    <section class="mb-10">
      <h2 class="text-lg font-bold mb-1" style="color: var(--c-text);">Connect an AI agent</h2>
      <p class="text-sm mb-5" style="color: var(--c-text-secondary);">
        Drop the key into your client of choice. Detailed guides live in <code>docs/integrations/</code>.
      </p>

      <div class="grid sm:grid-cols-2 gap-3">
        {#each [
          { name: 'Claude Code', cmd: 'claude mcp add celiums-memory \\\n  --url <ENGINE_URL>/mcp \\\n  --transport http \\\n  --header "Authorization: Bearer <YOUR_KEY>"' },
          { name: 'Cursor', cmd: 'Settings → MCP → Add Server\\nURL: <ENGINE_URL>/mcp\\nHeader: Authorization: Bearer <YOUR_KEY>' },
          { name: 'Claude Web', cmd: 'Settings → Connectors → Add custom\\nURL: <ENGINE_URL>/mcp\\nAuth: Bearer <YOUR_KEY>' },
          { name: 'VSCode (Continue/Cline)', cmd: 'Add to settings.json:\\n"mcpServers": { "celiums": { "url": "<ENGINE_URL>/mcp", "headers": { "Authorization": "Bearer <YOUR_KEY>" }}}' },
        ] as integ}
          <div class="rounded-xl p-4"
            style="border: 1px solid var(--c-border, rgba(253,246,227,0.12)); background: rgba(253,246,227,0.015);">
            <p class="text-sm font-semibold mb-2" style="color: var(--c-text);">{integ.name}</p>
            <pre class="text-[11px] font-mono whitespace-pre-wrap leading-relaxed"
              style="color: var(--c-text-secondary);">{integ.cmd.replace(/\\n/g, '\n')}</pre>
          </div>
        {/each}
      </div>
    </section>

    <!-- CTA -->
    <div class="flex items-center gap-3">
      <a href="/dashboard" class="btn-primary px-6 py-3 text-base">Enter dashboard →</a>
      <a href="/settings/keys" class="px-5 py-3 text-sm rounded-lg"
        style="border: 1px solid var(--c-border, rgba(253,246,227,0.12)); color: var(--c-text-secondary);">
        Manage keys
      </a>
    </div>

    {#if data.skipped}
      <p class="text-[11px] mt-6" style="color: var(--c-text-muted);">
        You skipped LLM setup. The memory primitives still work, but generation tools are disabled until you add a key.
      </p>
    {/if}
  </div>
</div>

<style>
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 20px rgba(34, 197, 94, 0.5); }
    50% { box-shadow: 0 0 40px rgba(34, 197, 94, 0.15); }
  }
</style>
